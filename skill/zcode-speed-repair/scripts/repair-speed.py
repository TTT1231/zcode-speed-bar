r"""Manage the speed bar injected into ZCode's app.asar. The default command is check.

The files beside this script are the source of truth. Machine-local state and deployed runtime files
live in ~/.zcode/zcode-speed. install and deploy sync the runtime files; remove
also syncs them before stripping the recognized bridge and loader. Removal
normally cleans the runtime directory, keeping backups/ after an unverified
--force strip. Running this script from inside that directory preserves it.

app.asar is located automatically through the Windows uninstall registry and
common install roots; pass --asar to override. Known versions live in targets.json
next to this script; add-version records a version with the registry variable
supplied by the caller. The minimum supported ZCode version is 3.17.1;
registration and runtime compatibility still need separate validation.

Registered renderer fingerprints are checked; mainSha256 is recorded but not
checked. Repacking verifies file contents, not whole-archive equality with an
official package.
"""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import tempfile
import time

SRC = Path(__file__).resolve().parent             # bundled files (source of truth)
RUNTIME = Path.home() / ".zcode" / "zcode-speed"  # deployed copies + machine-local state
TARGETS_PATH = SRC / "targets.json"
MAIN = "out/main/index.js"
BRIDGE_RE = re.compile(rb"\n?/\* zspeed-bridge:v1 begin \*/.*?/\* zspeed-bridge:v1 end \*/\n?", re.S)
# Matches a zusage loader line from any runtime directory (the directory can
# move between installs), so a new install never leaves a stale line behind.
LOADER_RE = re.compile(
    rb'\n;import\("[^"]*inject-main\.cjs"\)\.then\(\(\) => null, '
    rb'\(e\) => console\.error\("\[zusage\] load failed", e\)\);\n?')
# Store-shape evidence a candidate bundle must still contain for the bridge to
# work (contract in speed-bridge.js). Generic keys are useless as a gate.
FEATURES = (b"productTurnId", b"rowId", b"logEpoch", b"assistantText", b"projectionReady")
MIN_ZCODE_VERSION = (3, 17, 1)
BLOCK = 4194304
RUNTIME_FILES = ("inject-main.cjs", "speed-bridge.js", "targets.json", "repair-speed.py")
ESSENTIAL_FILES = ("inject-main.cjs", "speed-bridge.js")

def sha(data):
    return hashlib.sha256(data).hexdigest()

def read_header(stream):
    stream.seek(0)
    a, b, c, d = struct.unpack("<4I", stream.read(16))
    if a != 4 or d > b or b > 100_000_000:
        raise ValueError("Invalid ASAR header")
    return json.loads(stream.read(d)), 8 + b

def files(node, prefix=""):
    for name, item in node.get("files", {}).items():
        path = prefix + name
        if "files" in item:
            yield from files(item, path + "/")
        else:
            yield path, item

def read_file(stream, nodes, base, name):
    node = nodes[name]
    if node.get("unpacked"):
        raise ValueError("Target is unpacked: " + name)
    stream.seek(base + int(node["offset"]))
    data = stream.read(node["size"])
    if len(data) != node["size"]:
        raise ValueError("Truncated ASAR file: " + name)
    return data

def load_targets(path, required=True):
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        data = None
    except json.JSONDecodeError as e:
        if required:
            raise ValueError(f"Version registry {path} is corrupt: {e}")
        data = None
    if data is None:
        if required:
            raise ValueError(f"Version registry {path} is missing; run add-version first")
        return {}
    if not isinstance(data, dict) or not all(isinstance(v, dict) for v in data.values()):
        if required:
            raise ValueError(f"Version registry {path} is corrupt")
        return {}
    return data

def stamp(path):
    stat = path.stat()
    return stat.st_size, stat.st_mtime_ns, stat.st_ino

def file_sha(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(BLOCK):
            digest.update(chunk)
    return digest.hexdigest()

def asset(name):
    """The deployed runtime copy when present, else the source next to this script."""
    deployed = RUNTIME / name
    return deployed if deployed.is_file() else SRC / name

def deploy():
    """Sync the bundled files into the runtime directory; return what changed."""
    if SRC == RUNTIME.resolve():
        return []
    RUNTIME.mkdir(parents=True, exist_ok=True)
    deployed = []
    for name in RUNTIME_FILES:
        source, target = SRC / name, RUNTIME / name
        if not source.is_file():
            if not target.is_file() and name in ESSENTIAL_FILES:
                raise ValueError(f"{name} is missing from both {SRC} and {RUNTIME}")
            continue  # the runtime copy may legitimately carry files this bundle lacks
        if not target.is_file() or target.read_bytes() != source.read_bytes():
            shutil.copyfile(source, target)
            deployed.append(name)
    return deployed

def _registry_install_roots():
    """Install roots advertised by ZCode's Windows uninstall entries (NSIS writes these)."""
    roots, seen = [], set()
    if os.name != "nt":
        return roots
    try:
        import winreg
    except ImportError:
        return roots
    for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        for view in (0, winreg.KEY_WOW64_32KEY, winreg.KEY_WOW64_64KEY):
            try:
                uninstall = winreg.OpenKey(hive, r"Software\Microsoft\Windows\CurrentVersion\Uninstall",
                                           0, winreg.KEY_READ | view)
            except OSError:
                continue
            with uninstall:
                index = 0
                while True:
                    try:
                        entry = winreg.EnumKey(uninstall, index)
                        index += 1
                    except OSError:
                        break
                    try:
                        with winreg.OpenKey(uninstall, entry) as item:
                            display = str(winreg.QueryValueEx(item, "DisplayName")[0])
                            if "zcode" not in display.lower():
                                continue
                            location = Path(str(winreg.QueryValueEx(item, "InstallLocation")[0]))
                    except OSError:
                        continue
                    if location not in seen:
                        seen.add(location)
                        roots.append(location)
    return roots

def find_zcode_asar():
    """Auto-locate app.asar: uninstall registry first, then common install roots."""
    roots = _registry_install_roots()
    local = os.environ.get("LOCALAPPDATA")
    if local:
        roots.append(Path(local) / "Programs" / "ZCode")
    roots += [Path.home() / "AppData" / "Local" / "Programs" / "ZCode",
              Path(r"C:\Program Files\ZCode"), Path(r"C:\Program Files (x86)\ZCode"),
              Path(r"D:\soft\ZCode")]
    tried, seen, found = [], set(), []
    for root in roots:
        try:
            root = root.expanduser().resolve()
        except OSError:
            continue
        if root in seen:
            continue
        seen.add(root)
        candidate = root / "resources" / "app.asar"
        tried.append(str(candidate))
        if candidate.is_file() and (root / "ZCode.exe").is_file():
            found.append(candidate)
    if len(found) == 1:
        return found[0]
    if len(found) > 1:
        raise ValueError("Multiple ZCode installations found; select one with --asar:\n  " +
                         "\n  ".join(str(candidate) for candidate in found))
    raise ValueError("Could not locate ZCode's app.asar automatically; tried:\n  " + "\n  ".join(tried) +
                     "\nPass the path explicitly: --asar \"<ZCode install>\\resources\\app.asar\"")

def save_status(**fields):
    fields["updatedAt"] = time.time()
    (RUNTIME / "install-status.json").write_text(json.dumps(fields, ensure_ascii=False, indent=2), encoding="utf-8")

def purge_runtime(keep_backups):
    """Delete the runtime directory once nothing injected is left that might need restoring."""
    if not RUNTIME.is_dir():
        return "already absent"
    if SRC == RUNTIME.resolve():
        return "kept: this script runs inside it; delete the directory manually"
    if keep_backups:
        # Unverified strip: keep the backups for manual rollback, drop everything else.
        for child in RUNTIME.iterdir():
            if child.name == "backups":
                continue
            if child.is_dir():
                shutil.rmtree(child, ignore_errors=True)
            else:
                child.unlink(missing_ok=True)
        return "cleared; backups/ kept for manual rollback (unverified --force strip)"
    shutil.rmtree(RUNTIME, ignore_errors=True)
    return "purged" if not RUNTIME.exists() else f"not fully deleted; remove {RUNTIME} manually"

def ensure_no_pending(archive):
    meta_path = RUNTIME / "pending-install.json"
    pending = archive.with_name(archive.name + ".zspeed.pending")
    if meta_path.is_file() or pending.is_file():
        raise ValueError(
            "An unfinished pending replacement exists. Fully exit ZCode and wait for "
            "the existing operation to finish; do not start another one. If it does "
            f"not finish, inspect {meta_path} and install-status.json before changing {pending}.")

def wait_for_unlock(archive):
    """Finish this specific, verified repair when the running app releases ASAR."""
    meta_path = RUNTIME / "pending-install.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    pending = Path(meta["pending"])
    if (Path(meta["asar"]).resolve() != archive or Path(meta["runtime"]).resolve() != RUNTIME or
        pending.parent != archive.parent or pending.name != archive.name + ".zspeed.pending"):
        raise ValueError("Pending repair does not belong to this installation")
    final = {"install": "installed", "remove": "removed"}[meta.get("intent", "install")]
    pending_stamp = stamp(pending)
    if file_sha(pending) != meta["sha256"]:
        raise ValueError("Pending repair integrity mismatch")
    deadline = time.monotonic() + 24 * 3600
    while time.monotonic() < deadline:
        try:
            current_stamp = stamp(pending)
        except FileNotFoundError:
            save_status(state="cancelled", reason="Pending repair was deleted; old files were kept")
            return 1
        if list(stamp(archive)) != meta["originalStamp"] or current_stamp != pending_stamp:
            save_status(state="cancelled", reason="ZCode or the pending repair changed; old files were not applied")
            return 1
        try:
            os.replace(pending, archive)
        except PermissionError:
            time.sleep(0.5)
            continue
        save_status(state=final, version=meta["version"], verifiedFiles=meta["verifiedFiles"],
                    backup=meta["backup"], restartRequired=True)
        meta_path.unlink(missing_ok=True)
        purge = meta.get("purge")
        if purge and meta.get("intent") == "remove":
            purge_runtime(purge.get("keepBackups", False))
        return 0
    save_status(state="waiting-expired", reason="ZCode did not release the file within 24 hours")
    return 1

def start_waiter(archive):
    command = [os.sys.executable, str(Path(__file__).resolve()), "wait", "--asar", str(archive)]
    options = dict(stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    # No visible window, and keep the installer alive after the agent's tool exits.
    if os.name == "nt":
        try:
            return subprocess.Popen(command, creationflags=subprocess.CREATE_NO_WINDOW |
                                    subprocess.CREATE_BREAKAWAY_FROM_JOB, **options).pid
        except OSError:
            return subprocess.Popen(command, creationflags=subprocess.CREATE_NO_WINDOW, **options).pid
    return subprocess.Popen(command, start_new_session=True, **options).pid

class UnsupportedVersionError(ValueError):
    def __init__(self, reason, message):
        super().__init__(message)
        self.reason = reason

def read_version(stream, nodes, base):
    try:
        return json.loads(read_file(stream, nodes, base, "package.json"))["version"]
    except (KeyError, TypeError, ValueError, UnicodeDecodeError) as error:
        raise UnsupportedVersionError("unrecognized-version", "Cannot read the ZCode version from package.json") from error

def require_supported_version(version):
    """Reject releases below the minimum, including its prerelease versions."""
    minimum = ".".join(str(part) for part in MIN_ZCODE_VERSION)
    match = re.fullmatch(
        r"v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
        r"(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?"
        r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?",
        version if isinstance(version, str) else "",
    )
    if not match:
        raise UnsupportedVersionError(
            "unrecognized-version", f"Cannot determine whether ZCode version {version!r} meets the minimum {minimum}")
    release = tuple(int(part) for part in match.group(1, 2, 3))
    if release < MIN_ZCODE_VERSION or (release == MIN_ZCODE_VERSION and match.group(4)):
        raise UnsupportedVersionError(
            "version-too-low", f"ZCode {version} is below the minimum supported version {minimum}; "
                               "the ASAR was not changed")

def scan_bridge_asset(stream, nodes, base):
    """Find the asset carrying the bridge marker when the registry cannot point at it."""
    candidates = [name for name in nodes if name.startswith("out/renderer/assets/") and name.endswith(".js")]
    candidates.sort(key=lambda name: int(nodes[name]["size"]), reverse=True)
    for name in candidates:
        if b"zspeed-bridge:v1 begin" in read_file(stream, nodes, base, name):
            return name
    return None

def loader_line():
    url = (RUNTIME / "inject-main.cjs").as_uri()
    return ('\n;import(' + json.dumps(url) + ').then(() => null, '
            '(e) => console.error("[zusage] load failed", e));').encode()

def install_plan(stream, nodes, base, targets, version):
    if version not in targets:
        raise ValueError(f"ZCode {version} has no verified speed bridge; compatibility must be "
                         "checked before registering this version; the ASAR was not changed")
    entry = targets[version]
    asset_path, expected, registry = entry["asset"], entry["assetSha256"], entry["registry"]
    if asset_path not in nodes:
        raise ValueError(f"Registered asset {asset_path} is missing from the archive; the ASAR was not changed")
    old_asset = read_file(stream, nodes, base, asset_path)
    unpatched = BRIDGE_RE.sub(b"", old_asset)
    if sha(unpatched) != expected:
        raise ValueError("Renderer fingerprint mismatch; the ASAR was not changed")
    old_main = read_file(stream, nodes, base, MAIN)
    bridge = asset("speed-bridge.js").read_bytes().replace(b"__ZSPEED_REGISTRY__", registry.encode())
    line = loader_line()
    # Already injected counts regardless of the trailing newline older tools left out.
    if LOADER_RE.findall(old_main) not in ([line], [line + b"\n"]):
        new_main = LOADER_RE.sub(b"", old_main) + line + b"\n"  # drop lines from any runtime directory
    else:
        new_main = old_main
    return asset_path, {asset_path: old_asset, MAIN: old_main}, {asset_path: unpatched + b"\n" + bridge, MAIN: new_main}

def remove_plan(stream, nodes, base, targets, version, force):
    entry = targets.get(version)
    asset_path, old_asset, new_asset = None, None, None
    if entry is not None:
        asset_path = entry["asset"]
        if asset_path not in nodes:
            raise ValueError(f"Registered asset {asset_path} is missing from the archive; the ASAR was not changed")
        old_asset = read_file(stream, nodes, base, asset_path)
        new_asset = BRIDGE_RE.sub(b"", old_asset)
        if sha(new_asset) != entry["assetSha256"]:
            raise ValueError("Renderer does not match the registered clean fingerprint; the ASAR was not changed")
    else:
        asset_path = scan_bridge_asset(stream, nodes, base)
        if asset_path is not None and not force:
            raise ValueError(f"ZCode {version} is not registered; re-run remove with --force to skip "
                             "hash verification; the ASAR was not changed")
        if asset_path is not None:
            old_asset = read_file(stream, nodes, base, asset_path)
            new_asset = BRIDGE_RE.sub(b"", old_asset)
    old_main = read_file(stream, nodes, base, MAIN)
    old, wanted = {MAIN: old_main}, {MAIN: LOADER_RE.sub(b"", old_main)}
    if asset_path is not None:
        old[asset_path], wanted[asset_path] = old_asset, new_asset
    # Verified only when a registered fingerprint confirmed the clean result; an
    # unverified --force strip keeps the backups around for manual rollback.
    verified = entry is not None or asset_path is None
    return asset_path, old, wanted, verified

def syntax_check(contents):
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Node is required for the syntax check")
    with tempfile.TemporaryDirectory(prefix="zspeed-check-") as directory:
        for index, (name, content) in enumerate(contents.items()):
            target = Path(directory) / f"{index}.{'cjs' if name.endswith('.cjs') else 'mjs'}"
            target.write_bytes(content)
            subprocess.run([node, "--check", str(target)], check=True, capture_output=True)

def integrity(data):
    return {"algorithm": "SHA256", "hash": sha(data), "blockSize": BLOCK,
            "blocks": [sha(data[i:i + BLOCK]) for i in range(0, len(data), BLOCK)]}

def repack(source, destination, changes):
    with source.open("rb") as src:
        original, base = read_header(src)
        header = copy.deepcopy(original)
        old_nodes, new_nodes = dict(files(original)), dict(files(header))
        offset = 0
        for name, node in new_nodes.items():
            if node.get("unpacked") or "link" in node:
                continue
            if name in changes:
                node["size"] = len(changes[name])
                node["integrity"] = integrity(changes[name])
            node["offset"] = str(offset)
            offset += node["size"]
        encoded = json.dumps(header, ensure_ascii=False, separators=(",", ":")).encode()
        aligned = (len(encoded) + 4 + 3) // 4 * 4
        with destination.open("xb") as dst:
            dst.write(struct.pack("<4I", 4, aligned + 4, aligned, len(encoded)))
            dst.write(encoded)
            dst.write(b"\0" * (aligned - 4 - len(encoded)))
            for name, node in new_nodes.items():
                if node.get("unpacked") or "link" in node:
                    continue
                if name in changes:
                    dst.write(changes[name])
                else:
                    src.seek(base + int(old_nodes[name]["offset"]))
                    remaining = old_nodes[name]["size"]
                    while remaining:
                        chunk = src.read(min(BLOCK, remaining))
                        if not chunk:
                            raise ValueError("Truncated ASAR payload")
                        dst.write(chunk)
                        remaining -= len(chunk)
            dst.flush()
            os.fsync(dst.fileno())

def verify_repack(source, destination, changes):
    # Compare every packed file, including the bytes we did not edit.
    with source.open("rb") as src, destination.open("rb") as dst:
        old_header, old_base = read_header(src)
        new_header, new_base = read_header(dst)
        old_nodes, new_nodes = dict(files(old_header)), dict(files(new_header))
        if old_nodes.keys() != new_nodes.keys():
            raise ValueError("Repack changed the file list")
        checked = 0
        for name, node in old_nodes.items():
            if node.get("unpacked") or "link" in node:
                if node != new_nodes[name]:
                    raise ValueError("Repack changed an unpacked file")
                continue
            actual = read_file(dst, new_nodes, new_base, name)
            expected = changes.get(name)
            if expected is None:
                expected = read_file(src, old_nodes, old_base, name)
            if actual != expected:
                raise ValueError("Repack verification failed: " + name)
            if name in changes and new_nodes[name].get("integrity") != integrity(actual):
                raise ValueError("Modified file integrity mismatch: " + name)
            checked += 1
        return checked

def apply(archive, intent, version, old, wanted, report, purge_after=None):
    """Shared install/remove pipeline: backup, repack, verify, replace or pend."""
    original_stamp = stamp(archive)
    changes = {name: data for name, data in wanted.items() if old[name] != data}
    now = time.time()
    backup = RUNTIME / "backups" / (time.strftime("%Y%m%d-%H%M%S", time.localtime(now)) +
                                    f"-{int(now % 1 * 1000):03d}" +
                                    ("-host-" if intent == "install" else "-injected-") + version)
    backup.mkdir(parents=True, exist_ok=False)
    for name in changes:
        target = backup / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(old[name])
    (backup / "manifest.json").write_text(json.dumps({"intent": intent, "asar": str(archive),
        "version": version, "originalStamp": original_stamp,
        "files": {name: sha(old[name]) for name in changes}}, indent=2))
    pending = archive.with_name(archive.name + ".zspeed.pending")
    keep_pending = False
    try:
        repack(archive, pending, changes)
        checked = verify_repack(archive, pending, changes)
        if stamp(archive) != original_stamp:
            raise RuntimeError("ZCode updated during repair; current app was left untouched")
        try:
            os.replace(pending, archive)
        except PermissionError:
            metadata = {"intent": intent, "version": version, "asar": str(archive), "runtime": str(RUNTIME),
                        "originalStamp": original_stamp, "pending": str(pending),
                        "sha256": file_sha(pending), "verifiedFiles": checked, "backup": str(backup),
                        "purge": purge_after}
            (RUNTIME / "pending-install.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
            keep_pending = True
            save_status(state="pending", intent=intent, version=version,
                        verifiedFiles=checked, backup=str(backup))
            monitor_pid = start_waiter(archive)
            report.update(state="pending-until-ZCode-exits", intent=intent,
                          verifiedFiles=checked, backup=str(backup), monitorPid=monitor_pid, pending=True)
            if purge_after is not None:
                report["runtimeDir"] = "deleted automatically once the pending removal completes"
            print(json.dumps(report, ensure_ascii=False, indent=2))
            return 0
    finally:
        if not keep_pending:
            pending.unlink(missing_ok=True)
    final = {"install": "installed", "remove": "removed"}[intent]
    save_status(state=final, version=version, verifiedFiles=checked, backup=str(backup), restartRequired=True)
    report.update(bridge=intent == "install", loader=intent == "install")
    if purge_after is not None:
        report["runtimeDir"] = purge_runtime(purge_after["keepBackups"])
    report.update(state=final, verifiedFiles=checked, backup=str(backup), restartRequired=True)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0

def context_snippets(data, radius=100):
    """Excerpts around each feature string to help locate the registry variable."""
    snippets = {}
    for feature in FEATURES:
        index = data.find(feature)
        if index >= 0:
            snippets[feature.decode()] = data[max(0, index - radius):index + radius].decode("utf-8", "replace")
    return snippets

def add_version(archive, args):
    if not args.registry or not re.fullmatch(r"[A-Za-z_$][A-Za-z0-9_$]*", args.registry):
        raise ValueError("--registry must name the bundle variable holding the store registry")
    with archive.open("rb") as stream:
        header, base = read_header(stream)
        nodes = dict(files(header))
        version = read_version(stream, nodes, base)
        require_supported_version(version)
        asset_path = args.asset
        if asset_path is None:
            asset_path = max((name for name in nodes
                              if name.startswith("out/renderer/assets/") and name.endswith(".js")),
                             key=lambda name: int(nodes[name]["size"]))
        if asset_path not in nodes:
            raise ValueError(f"{asset_path} is not in the archive")
        clean = BRIDGE_RE.sub(b"", read_file(stream, nodes, base, asset_path))
        missing = [feature.decode() for feature in FEATURES if feature not in clean]
        if missing:
            raise ValueError(f"{asset_path} lacks the store shape the bridge reads "
                             f"({', '.join(missing)}); speed-bridge.js needs updating before {version} can be registered")
        main_clean = LOADER_RE.sub(b"", read_file(stream, nodes, base, MAIN))
    targets = load_targets(args.targets, required=False)
    if version in targets and not args.force:
        raise ValueError(f"{version} is already registered; re-run with --force to overwrite")
    targets[version] = {"asset": asset_path, "assetSha256": sha(clean), "main": MAIN,
                        "mainSha256": sha(main_clean), "registry": args.registry}
    args.targets.write_text(json.dumps(targets, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
                            encoding="utf-8")
    print(json.dumps({"registered": version, "targets": str(args.targets), "asset": asset_path,
                      "assetSha256": targets[version]["assetSha256"],
                      "mainSha256": targets[version]["mainSha256"], "registry": args.registry,
                      "featureContext": context_snippets(clean)}, ensure_ascii=False, indent=2))
    return 0

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["install", "remove", "check", "wait", "add-version", "deploy"],
                        nargs="?", default="check")
    parser.add_argument("--asar", type=Path, default=None,
                        help="path to app.asar (default: auto-detect the ZCode installation)")
    parser.add_argument("--targets", type=Path, default=TARGETS_PATH)
    parser.add_argument("--registry", help="bundle variable holding the store registry (add-version)")
    parser.add_argument("--asset", help="bundle path inside the asar (add-version; default: largest renderer asset)")
    parser.add_argument("--force", action="store_true",
                        help="overwrite a registered version (add-version) or strip an unregistered one (remove)")
    args = parser.parse_args()
    archive = (args.asar if args.asar is not None else find_zcode_asar()).resolve()
    if not (archive.parent.parent / "ZCode.exe").is_file():
        raise ValueError("Target is not a ZCode installation")
    if args.command == "wait":
        return wait_for_unlock(archive)
    if args.command == "add-version":
        return add_version(archive, args)
    deployed = []
    with archive.open("rb") as stream:
        header, base = read_header(stream)
        nodes = dict(files(header))
        version = None
        try:
            version = read_version(stream, nodes, base)
            if args.command != "remove":
                require_supported_version(version)
        except UnsupportedVersionError as error:
            if args.command not in ("install", "deploy"):
                raise
            print(json.dumps({"state": "skipped", "reason": error.reason, "version": version,
                              "minimumVersion": ".".join(str(part) for part in MIN_ZCODE_VERSION),
                              "asar": str(archive), "message": str(error)}, ensure_ascii=False, indent=2))
            return 1
        if args.command == "deploy":
            ensure_no_pending(archive)
            print(json.dumps({"version": version, "asar": str(archive), "source": str(SRC),
                              "runtime": str(RUNTIME), "deployed": deploy()}, ensure_ascii=False, indent=2))
            return 0
        if args.command in ("install", "remove"):
            ensure_no_pending(archive)
            deployed = deploy()
        targets = load_targets(args.targets, required=(args.command != "remove"))
        if args.command == "remove":
            asset_path, old, wanted, verified = remove_plan(stream, nodes, base, targets, version, args.force)
        else:
            asset_path, old, wanted = install_plan(stream, nodes, base, targets, version)
    changes = {name: data for name, data in wanted.items() if old[name] != data}
    syntax_check({**wanted, "inject-main.cjs": asset("inject-main.cjs").read_bytes()})
    report = {"version": version, "asar": str(archive), "runtime": str(RUNTIME), "syntax": "ok"}
    if deployed:
        report["deployed"] = deployed
    if args.command == "remove":
        report["bridge"] = asset_path is not None and old[asset_path] != wanted[asset_path]
        report["loader"] = old[MAIN] != wanted[MAIN]
    else:
        report["bridge"] = asset_path is not None and old[asset_path] == wanted[asset_path]
        report["loader"] = old[MAIN] == wanted[MAIN]
    if args.command == "check":
        report["pending"] = ((RUNTIME / "pending-install.json").is_file() or
                             archive.with_name(archive.name + ".zspeed.pending").is_file())
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0 if not changes and not report["pending"] else 1
    report["pending"] = False
    if not changes:  # install: already injected; remove: already clean
        if args.command == "remove":
            save_status(state="removed", version=version)
            report.update(state="removed", alreadyClean=True, restartRequired=True)
            report["runtimeDir"] = purge_runtime(keep_backups=not verified)
        else:
            report.update(state="installed", alreadyInstalled=True, restartRequired=True)
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0
    purge_after = {"keepBackups": not verified} if args.command == "remove" else None
    return apply(archive, args.command, version, old, wanted, report, purge_after)

if __name__ == "__main__":
    raise SystemExit(main())
