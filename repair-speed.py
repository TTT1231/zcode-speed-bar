"""Compatibility entry point for the self-contained ZCode speed skill."""

from pathlib import Path
import runpy


if __name__ == "__main__":
    script = Path(__file__).resolve().parent / "skill" / "zcode-speed-repair" / "scripts" / "repair-speed.py"
    runpy.run_path(str(script), run_name="__main__")
