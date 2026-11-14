"""Start the local app with an API key entered at the terminal."""

import os
import sys
from getpass import getpass

import uvicorn


def main():
    if not os.getenv("OPENAI_API_KEY"):
        if not sys.stdin.isatty():
            sys.exit("Run this command in Terminal or set OPENAI_API_KEY in the environment.")
        key = getpass("OpenAI API key (input hidden): ").strip()
        if not key:
            sys.exit("An OpenAI API key is required for PDF uploads.")
        os.environ["OPENAI_API_KEY"] = key

    uvicorn.run("backend.main:create_app", factory=True, host="127.0.0.1", port=8000)


if __name__ == "__main__":
    main()
