"""Exercise the distributable skill against isolated synthetic ZCode installations."""

import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


SKILL = Path(__file__).resolve().parent / "skill" / "zcode-speed-repair"
ROOT_ENTRY = Path(__file__).resolve().parent / "repair-speed.py"
ASSET = "out/renderer/assets/bundle.js"
MAIN = "out/main/index.js"
VERSION = "3.17.1"
ORIGINAL = {
    "package.json": json.dumps({"version": VERSION}).encode(),
    MAIN: b"console.log('synthetic main');",
    ASSET: b"var np = new Map();",
    "unrelated/data.bin": b"\x00\x01unchanged\xff",
}


def make_asar(path, contents):
    header = {"files": {}}
    payload = bytearray()
    for name, data in contents.items():
        parts = name.split("/")
        node = header
        for part in parts[:-1]:
            node = node["files"].setdefault(part, {"files": {}})
        node["files"][parts[-1]] = {"size": len(data), "offset": str(len(payload))}
        payload.extend(data)
    encoded = json.dumps(header, separators=(",", ":")).encode()
    aligned = (len(encoded) + 7) // 4 * 4
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(struct.pack("<4I", 4, aligned + 4, aligned, len(encoded)) + encoded +
                     b"\0" * (aligned - 4 - len(encoded)) + payload)


def unpack_asar(path):
    with path.open("rb") as stream:
        _, size, _, json_size = struct.unpack("<4I", stream.read(16))
        header = json.loads(stream.read(json_size))
        base = 8 + size
        contents = {}

        def visit(node, prefix=""):
            for name, item in node["files"].items():
                name = prefix + name
                if "files" in item:
                    visit(item, name + "/")
                else:
                    stream.seek(base + int(item["offset"]))
                    contents[name] = stream.read(item["size"])

        visit(header)
        return contents


class RepairSpeedTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="zspeed-tests-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.skill = self.root / "standalone skill"
        shutil.copytree(SKILL, self.skill, ignore=shutil.ignore_patterns("__pycache__"))
        self.script = self.skill / "scripts" / "repair-speed.py"
        self.targets = self.skill / "scripts" / "targets.json"
        self.targets.write_text(json.dumps({VERSION: {
            "asset": ASSET,
            "assetSha256": hashlib.sha256(ORIGINAL[ASSET]).hexdigest(),
            "main": MAIN,
            "mainSha256": hashlib.sha256(ORIGINAL[MAIN]).hexdigest(),
            "registry": "np",
        }}), encoding="utf-8")
        self.home = self.root / "home"
        self.home.mkdir()
        self.runtime = self.home / ".zcode" / "zcode-speed"
        self.env = os.environ.copy()
        self.env.update(HOME=str(self.home), USERPROFILE=str(self.home))
        self.installation = self.root / "synthetic ZCode"
        self.installation.mkdir()
        (self.installation / "ZCode.exe").write_bytes(b"")
        self.archive = self.installation / "resources" / "app.asar"
        make_asar(self.archive, ORIGINAL)

    def cli(self, command, *args, expected=0):
        result = subprocess.run([sys.executable, str(self.script), command, "--asar", str(self.archive), *args],
                                cwd=self.root, env=self.env, text=True, capture_output=True)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return result

    def load_script(self):
        spec = importlib.util.spec_from_file_location("zspeed_test_module", self.script)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.RUNTIME = self.runtime
        return module

    def start_pending(self, command):
        """Run a command whose archive replacement hits the file lock; returns the script and its report."""
        if command == "remove":
            self.cli("install")
        module = self.load_script()
        output = io.StringIO()
        with mock.patch.object(sys, "argv", [str(self.script), command, "--asar", str(self.archive)]), \
             mock.patch.object(module.os, "replace", side_effect=PermissionError("simulated lock")), \
             mock.patch.object(module, "start_waiter", return_value=1234), \
             contextlib.redirect_stdout(output):
            self.assertEqual(module.main(), 0)
        return module, json.loads(output.getvalue())

    def test_copied_skill_installs_checks_and_removes_without_repository(self):
        self.cli("check", expected=1)
        installed = json.loads(self.cli("install").stdout)
        self.assertEqual((installed["state"], installed["pending"]), ("installed", False))
        self.assertTrue(installed["bridge"] and installed["loader"])
        patched = unpack_asar(self.archive)
        self.assertEqual(patched["unrelated/data.bin"], ORIGINAL["unrelated/data.bin"])
        self.assertIn(b"zspeed-bridge:v1 begin", patched[ASSET])
        self.assertIn(b"inject-main.cjs", patched[MAIN])
        backups = list((self.runtime / "backups").glob("*-host-*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual((backups[0] / ASSET).read_bytes(), ORIGINAL[ASSET])
        after_install = self.archive.read_bytes()
        again = json.loads(self.cli("install").stdout)
        self.assertTrue(again["alreadyInstalled"])
        self.assertEqual(self.archive.read_bytes(), after_install)
        checked = json.loads(self.cli("check").stdout)
        self.assertTrue(checked["bridge"] and checked["loader"] and not checked["pending"])
        removed = json.loads(self.cli("remove").stdout)
        self.assertEqual((removed["state"], removed["pending"]), ("removed", False))
        self.assertFalse(removed["bridge"] or removed["loader"])
        self.assertEqual(unpack_asar(self.archive), ORIGINAL)
        self.assertFalse(self.runtime.exists())
        self.cli("check", expected=1)
        self.assertTrue(json.loads(self.cli("remove").stdout)["alreadyClean"])
        self.assertFalse(self.runtime.exists())

    def test_wrong_renderer_fingerprint_never_changes_archive(self):
        modified = dict(ORIGINAL, **{ASSET: b"var np = new Map(); // modified"})
        make_asar(self.archive, modified)
        before = self.archive.read_bytes()
        result = self.cli("install", expected=1)
        self.assertIn("fingerprint mismatch", result.stderr)
        self.assertEqual(self.archive.read_bytes(), before)

    def test_minimum_version_uses_numeric_and_prerelease_ordering(self):
        module = self.load_script()
        for version in ("3.17.1", "v3.17.1", "3.17.1+build.1", "3.17.2-rc.1", "3.18.0", "4.0.0"):
            with self.subTest(version=version):
                module.require_supported_version(version)
        for version in ("2.99.99", "3.16.99", "3.17.0", "3.17.1-rc.1", "unknown", None):
            with self.subTest(version=version), self.assertRaises(ValueError):
                module.require_supported_version(version)

    def test_old_version_cannot_be_installed_checked_or_registered_even_if_listed(self):
        old_version = "3.17.0"
        contents = dict(ORIGINAL, **{"package.json": json.dumps({"version": old_version}).encode()})
        make_asar(self.archive, contents)
        targets = json.loads(self.targets.read_text(encoding="utf-8"))
        targets[old_version] = targets[VERSION]
        self.targets.write_text(json.dumps(targets), encoding="utf-8")
        before_archive = self.archive.read_bytes()
        before_targets = self.targets.read_bytes()
        for command, args in (("install", ("--force",)), ("deploy", ()), ("check", ()),
                              ("add-version", ("--registry", "np", "--force"))):
            with self.subTest(command=command):
                result = self.cli(command, *args, expected=1)
                if command in ("install", "deploy"):
                    report = json.loads(result.stdout)
                    self.assertEqual((report["state"], report["reason"]), ("skipped", "version-too-low"))
                    self.assertEqual((report["version"], report["minimumVersion"]), (old_version, "3.17.1"))
                else:
                    self.assertIn("below the minimum supported version 3.17.1", result.stderr)
                self.assertEqual(self.archive.read_bytes(), before_archive)
                self.assertEqual(self.targets.read_bytes(), before_targets)
                self.assertFalse(self.runtime.exists())

    def test_preflight_preserves_existing_runtime_for_prerelease_and_unknown_versions(self):
        self.runtime.mkdir(parents=True)
        runtime_file = self.runtime / "inject-main.cjs"
        runtime_file.write_bytes(b"existing runtime file")
        for version, reason in (("3.17.1-rc.1", "version-too-low"), ("unknown", "unrecognized-version")):
            with self.subTest(version=version):
                contents = dict(ORIGINAL, **{"package.json": json.dumps({"version": version}).encode()})
                make_asar(self.archive, contents)
                before = self.archive.read_bytes()
                for command in ("install", "deploy"):
                    report = json.loads(self.cli(command, expected=1).stdout)
                    self.assertEqual((report["state"], report["reason"]), ("skipped", reason))
                    self.assertEqual(self.archive.read_bytes(), before)
                    self.assertEqual(runtime_file.read_bytes(), b"existing runtime file")
                    self.assertEqual([item.name for item in self.runtime.iterdir()], ["inject-main.cjs"])

    def test_missing_or_unreadable_version_skips_without_writing(self):
        for package in (None, b"{}", b"not json", b"null"):
            with self.subTest(package=package):
                contents = dict(ORIGINAL)
                if package is None:
                    del contents["package.json"]
                else:
                    contents["package.json"] = package
                make_asar(self.archive, contents)
                before = self.archive.read_bytes()
                for command in ("install", "deploy"):
                    report = json.loads(self.cli(command, expected=1).stdout)
                    self.assertEqual((report["state"], report["reason"]), ("skipped", "unrecognized-version"))
                    self.assertIsNone(report["version"])
                    self.assertEqual(self.archive.read_bytes(), before)
                    self.assertFalse(self.runtime.exists())

    def test_deploy_checks_version_before_copying_runtime_files(self):
        before = self.archive.read_bytes()
        report = json.loads(self.cli("deploy").stdout)
        self.assertEqual(report["version"], VERSION)
        self.assertIn("inject-main.cjs", report["deployed"])
        self.assertEqual(self.archive.read_bytes(), before)
        self.assertEqual((self.runtime / "inject-main.cjs").read_bytes(),
                         (self.skill / "scripts" / "inject-main.cjs").read_bytes())

    def test_newer_version_still_needs_registration(self):
        contents = dict(ORIGINAL, **{"package.json": json.dumps({"version": "3.18.0"}).encode()})
        make_asar(self.archive, contents)
        result = self.cli("install", expected=1)
        self.assertIn("has no verified speed bridge", result.stderr)

    def test_supported_versions_can_be_registered_after_feature_checks(self):
        asset = b"var np, productTurnId, rowId, logEpoch, assistantText, projectionReady;"
        for version in ("3.17.1", "3.18.0"):
            with self.subTest(version=version):
                contents = dict(ORIGINAL, **{
                    "package.json": json.dumps({"version": version}).encode(), ASSET: asset,
                })
                make_asar(self.archive, contents)
                self.targets.write_text("{}", encoding="utf-8")
                report = json.loads(self.cli("add-version", "--registry", "np").stdout)
                self.assertEqual(report["registered"], version)
                registered = json.loads(self.targets.read_text(encoding="utf-8"))[version]
                self.assertEqual(registered["assetSha256"], hashlib.sha256(asset).hexdigest())
                self.assertFalse(self.runtime.exists())

    def test_removal_can_clean_an_older_version(self):
        self.cli("install")
        contents = unpack_asar(self.archive)
        contents["package.json"] = json.dumps({"version": "3.17.0"}).encode()
        make_asar(self.archive, contents)
        targets = json.loads(self.targets.read_text(encoding="utf-8"))
        targets["3.17.0"] = targets[VERSION]
        self.targets.write_text(json.dumps(targets), encoding="utf-8")
        self.assertEqual(json.loads(self.cli("remove").stdout)["state"], "removed")
        expected = dict(ORIGINAL, **{"package.json": contents["package.json"]})
        self.assertEqual(unpack_asar(self.archive), expected)
        self.assertFalse(self.runtime.exists())

    def test_root_compatibility_entry_installs_with_explicit_targets(self):
        result = subprocess.run([sys.executable, str(ROOT_ENTRY), "install", "--asar", str(self.archive),
                                 "--targets", str(self.targets)], cwd=self.root, env=self.env,
                                text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(json.loads(result.stdout)["state"], "installed")
        self.assertIn(b"zspeed-bridge:v1 begin", unpack_asar(self.archive)[ASSET])

    def test_unregistered_version_is_not_registered_or_installed(self):
        self.targets.write_text("{}", encoding="utf-8")
        before = self.archive.read_bytes()
        result = self.cli("install", expected=1)
        self.assertIn("compatibility must be checked", result.stderr)
        self.assertEqual(self.archive.read_bytes(), before)
        self.assertEqual(self.targets.read_text(encoding="utf-8"), "{}")

    def test_remove_rejects_changed_registered_renderer(self):
        self.cli("install")
        changed = unpack_asar(self.archive)
        changed[ASSET] += b"\n// unexpected host modification"
        make_asar(self.archive, changed)
        before = self.archive.read_bytes()
        result = self.cli("remove", "--force", expected=1)
        self.assertIn("clean fingerprint", result.stderr)
        self.assertEqual(self.archive.read_bytes(), before)
        self.assertTrue(self.runtime.is_dir())

    def test_unregistered_forced_removal_retains_backups(self):
        self.cli("install")
        self.targets.write_text("{}", encoding="utf-8")
        before = self.archive.read_bytes()
        self.cli("remove", expected=1)
        self.assertEqual(self.archive.read_bytes(), before)
        removed = json.loads(self.cli("remove", "--force").stdout)
        self.assertIn("backups/ kept", removed["runtimeDir"])
        self.assertEqual(unpack_asar(self.archive), ORIGINAL)
        self.assertEqual([item.name for item in self.runtime.iterdir()], ["backups"])
        self.assertTrue(list((self.runtime / "backups").glob("*-injected-*")))

    def test_pending_remove_reports_current_state_and_cleans_only_after_replace(self):
        module, report = self.start_pending("remove")
        self.assertEqual((report["state"], report["pending"]), ("pending-until-ZCode-exits", True))
        self.assertTrue(report["bridge"] and report["loader"])
        self.assertTrue(self.runtime.is_dir())
        self.assertIn(b"zspeed-bridge:v1 begin", unpack_asar(self.archive)[ASSET])
        checked = json.loads(self.cli("check", expected=1).stdout)
        self.assertTrue(checked["pending"])
        self.cli("remove", expected=1)
        self.assertTrue(self.runtime.is_dir())
        self.assertEqual(module.wait_for_unlock(self.archive.resolve()), 0)
        self.assertEqual(unpack_asar(self.archive), ORIGINAL)
        self.assertFalse(self.runtime.exists())

    def test_pending_install_reports_current_state_until_replacement(self):
        module, report = self.start_pending("install")
        self.assertTrue(report["pending"])
        self.assertFalse(report["bridge"] or report["loader"])
        self.assertEqual(unpack_asar(self.archive), ORIGINAL)
        self.assertEqual(module.wait_for_unlock(self.archive.resolve()), 0)
        checked = json.loads(self.cli("check").stdout)
        self.assertTrue(checked["bridge"] and checked["loader"] and not checked["pending"])

    def test_tampered_pending_file_is_not_applied(self):
        module, _ = self.start_pending("remove")
        before = self.archive.read_bytes()
        pending = self.archive.with_name(self.archive.name + ".zspeed.pending")
        pending.write_bytes(pending.read_bytes() + b"tampered")
        with self.assertRaisesRegex(ValueError, "integrity mismatch"):
            module.wait_for_unlock(self.archive.resolve())
        self.assertEqual(self.archive.read_bytes(), before)
        self.assertTrue(pending.is_file())
        self.assertTrue(self.runtime.is_dir())

    def test_pending_is_cancelled_if_original_archive_changes(self):
        module, _ = self.start_pending("remove")
        self.archive.write_bytes(self.archive.read_bytes() + b"host updated")
        changed = self.archive.read_bytes()
        self.assertEqual(module.wait_for_unlock(self.archive.resolve()), 1)
        self.assertEqual(self.archive.read_bytes(), changed)
        self.assertTrue(self.runtime.is_dir())
        status = json.loads((self.runtime / "install-status.json").read_text(encoding="utf-8"))
        self.assertEqual(status["state"], "cancelled")

    def test_removal_from_runtime_preserves_its_own_files(self):
        self.cli("install")
        runtime_script = self.runtime / "repair-speed.py"
        result = subprocess.run([sys.executable, str(runtime_script), "remove", "--asar", str(self.archive)],
                                cwd=self.root, env=self.env, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("kept: this script runs inside it", json.loads(result.stdout)["runtimeDir"])
        self.assertEqual(unpack_asar(self.archive), ORIGINAL)
        self.assertTrue(runtime_script.is_file())
        self.assertTrue((self.runtime / "backups").is_dir())

    def test_check_detects_orphaned_pending_file(self):
        self.cli("install")
        before = self.archive.read_bytes()
        pending = self.archive.with_name(self.archive.name + ".zspeed.pending")
        pending.write_bytes(b"unfinished")
        report = json.loads(self.cli("check", expected=1).stdout)
        self.assertTrue(report["pending"])
        self.cli("install", expected=1)
        self.cli("remove", expected=1)
        self.cli("deploy", expected=1)
        self.assertEqual(self.archive.read_bytes(), before)
        self.assertEqual(pending.read_bytes(), b"unfinished")

    def test_automatic_discovery_refuses_multiple_installations(self):
        other = self.root / "other ZCode"
        (other / "resources").mkdir(parents=True)
        (other / "resources" / "app.asar").write_bytes(b"")
        (other / "ZCode.exe").write_bytes(b"")
        module = self.load_script()
        with mock.patch.object(module, "_registry_install_roots", return_value=[self.installation, other]):
            with self.assertRaisesRegex(ValueError, "Multiple ZCode installations") as error:
                module.find_zcode_asar()
        self.assertIn(str(self.archive), str(error.exception))
        self.assertIn(str(other / "resources" / "app.asar"), str(error.exception))


if __name__ == "__main__":
    unittest.main()
