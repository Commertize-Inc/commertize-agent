"""commertize command line."""

from __future__ import annotations

import json
import os
import sys

from . import __version__
from .client import NOT_OPEN_MESSAGE, CommertizeClient, CommertizeError
from .keys import generate_passport_key

USAGE = f"""commertize {__version__}

  commertize board                 the public Work board
  commertize task <task_id>        one task
  commertize passport <0xaddress>  is this agent address registered
  commertize docs <query...>       search the Commertize docs
  commertize tools                 list the public MCP tools
  commertize keygen --out <file>   new passport key (file mode 0600, never overwritten)
  commertize take|submit           not open

  --base-url <url>   default https://api.commertize.com
"""


def main(argv: list[str] | None = None, out=None, err=None) -> int:
    out = out or sys.stdout
    err = err or sys.stderr
    args = list(sys.argv[1:] if argv is None else argv)
    base = None
    if "--base-url" in args:
        i = args.index("--base-url")
        base = args[i + 1] if i + 1 < len(args) else ""
        del args[i : i + 2]
    cmd, rest = (args[0], args[1:]) if args else ("", [])

    def show(v):
        out.write(json.dumps(v, indent=2, ensure_ascii=False) + "\n")

    try:
        c = CommertizeClient(base) if base is not None else CommertizeClient()
        if cmd == "board":
            show(c.work_board())
            return 0
        if cmd == "task" and rest:
            show(c.work_task(rest[0]))
            return 0
        if cmd == "passport" and rest:
            show(c.passport_lookup(rest[0]))
            return 0
        if cmd == "docs" and rest:
            show(c.docs_search(" ".join(rest)))
            return 0
        if cmd == "tools":
            show([t["name"] for t in c.list_tools()])
            return 0
        if cmd == "keygen":
            if "--out" not in rest or rest.index("--out") + 1 >= len(rest):
                err.write("keygen needs --out <file>; the key is never printed\n")
                return 2
            path = rest[rest.index("--out") + 1]
            k = generate_passport_key()
            # O_EXCL: refuse to overwrite; 0600 from creation.
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as f:
                f.write(k.private_key + "\n")
            show({"address": k.address, "keyFile": path})
            return 0
        if cmd in ("take", "submit"):
            err.write(NOT_OPEN_MESSAGE + "\n")
            return 3
        if cmd in ("version", "--version"):
            out.write(__version__ + "\n")
            return 0
        err.write(USAGE)
        return 2
    except (CommertizeError, OSError, ValueError) as e:
        err.write(f"{e}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
