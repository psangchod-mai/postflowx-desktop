"""Shared pytest fixtures and configuration."""
import sys
from pathlib import Path

# Ensure the companion src package is importable when running tests directly
src = Path(__file__).parent.parent / "src"
if str(src) not in sys.path:
    sys.path.insert(0, str(src))
