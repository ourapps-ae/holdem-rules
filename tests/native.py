"""Compile and execute the native consumer with installed tools."""
from pathlib import Path
import subprocess
import sys
import tempfile

root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as directory:
    output = Path(directory) / "consumer"
    if sys.argv[1] == "apple":
        sources = sorted((root / "implementation/apple/Sources").glob("*.swift"))
        subprocess.run(["swiftc", *map(str, sources), str(root / "tests/apple/main.swift"), "-o", str(output)], check=True)
        subprocess.run([str(output)], cwd=root, check=True)
    elif sys.argv[1] == "android":
        sources = sorted((root / "implementation/android/src/main/java").rglob("*.kt"))
        jar = str(output) + ".jar"
        subprocess.run(["kotlinc", *map(str, sources), str(root / "tests/android/Main.kt"), "-include-runtime", "-d", jar], check=True)
        subprocess.run(["java", "-jar", jar], cwd=root, check=True)
    else:
        raise SystemExit("expected apple or android")
