"""Rock-type / deposit-type ID assignment + JSON sidecar emitter."""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path


def _fallback_color(name: str) -> str:
    """Deterministic pastel colour from name hash (used when palette has no entry)."""
    h = hashlib.sha1(name.encode("utf-8")).digest()
    # bias toward mid-range so colours look pastel/legible
    r = 100 + (h[0] % 130)
    g = 100 + (h[1] % 130)
    b = 100 + (h[2] % 130)
    return f"#{r:02x}{g:02x}{b:02x}"


@dataclass
class Lookup:
    palette: dict[str, str] = field(default_factory=dict)   # name (lowercased) -> hex
    _name_to_id: dict[str, int] = field(default_factory=dict, init=False)
    _entries: list[dict] = field(default_factory=list, init=False)

    def id_for(self, name: str, scale: str) -> int:
        if name not in self._name_to_id:
            i = len(self._entries)
            colour = self.palette.get(name.lower(), _fallback_color(name))
            self._entries.append({"name": name, "color": colour, "scale": scale})
            self._name_to_id[name] = i
        return self._name_to_id[name]

    def write(self, path: Path) -> None:
        out = {str(i): e for i, e in enumerate(self._entries)}
        path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
