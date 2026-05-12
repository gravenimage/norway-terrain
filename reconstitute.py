"""Reconstitute split data files from data_parts/.

GitHub blocks individual files larger than 100 MB, so a couple of the binary
data files are committed split into chunks under `data_parts/`. Run this
script once after cloning to glue them back together:

    python reconstitute.py

Re-running the script is idempotent: existing fully-reconstituted files are
left alone if their size already matches the sum of the parts.
"""
from __future__ import annotations
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PARTS_DIR = ROOT / "data_parts"

# Output filename -> ordered list of part filenames (sorted lexicographically).
TARGETS = ["rogaland_10m.tif", "canopy.bin", "bedrock.bin", "quaternary.bin"]


def run() -> None:
    """Reconstitute any missing/incomplete split files. Safe to call repeatedly."""
    if not PARTS_DIR.is_dir():
        sys.exit(f"data_parts/ not found at {PARTS_DIR}")
    any_work = False
    for t in TARGETS:
        out = ROOT / t
        parts = sorted(PARTS_DIR.glob(f"{t}.part*"))
        if not parts:
            print(f"  {t}: no parts found in data_parts/, skipping")
            continue
        expected = sum(p.stat().st_size for p in parts)
        if out.exists() and out.stat().st_size == expected:
            print(f"  {t}: OK ({expected/1e6:.1f} MB, already reconstituted)")
            continue
        any_work = True
        print(f"  {t}: joining {len(parts)} parts -> {expected/1e6:.1f} MB ...", flush=True)
        with out.open("wb") as o:
            for p in parts:
                o.write(p.read_bytes())
        if out.stat().st_size != expected:
            sys.exit(f"ERROR: {t} size mismatch after join")
        print(f"  {t}: done")
    if not any_work:
        print("  (nothing to do, all data files already present)")


def main() -> None:
    print("Reconstituting data files...")
    run()
    print("Done.")


if __name__ == "__main__":
    main()
