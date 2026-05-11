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
TARGETS = ["rogaland_10m.tif", "canopy.bin"]


def reconstitute(target: str) -> None:
    out = ROOT / target
    parts = sorted(PARTS_DIR.glob(f"{target}.part*"))
    if not parts:
        print(f"  {target}: no parts found in data_parts/, skipping")
        return
    expected = sum(p.stat().st_size for p in parts)
    if out.exists() and out.stat().st_size == expected:
        print(f"  {target}: already up to date ({expected/1e6:.1f} MB)")
        return
    print(f"  {target}: joining {len(parts)} parts -> {expected/1e6:.1f} MB")
    with out.open("wb") as o:
        for p in parts:
            o.write(p.read_bytes())
    if out.stat().st_size != expected:
        sys.exit(f"ERROR: {target} size mismatch after join")


def main() -> None:
    if not PARTS_DIR.is_dir():
        sys.exit(f"data_parts/ not found at {PARTS_DIR}")
    print("Reconstituting data files...")
    for t in TARGETS:
        reconstitute(t)
    print("Done.")


if __name__ == "__main__":
    main()
