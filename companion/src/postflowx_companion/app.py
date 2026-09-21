from __future__ import annotations

import argparse
import sys

from .http_server import run_http_server
from .native_host import run_native_host


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="postflowx-companion")
    parser.add_argument(
        "--mode",
        choices=["native-host", "http"],
        default="native-host",
        help="Run as Chrome native messaging host or HTTP session server.",
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=47125)
    args, _ = parser.parse_known_args(argv)

    if args.mode == "http":
        run_http_server(host=args.host, port=args.port)
        return 0
    return run_native_host()


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

