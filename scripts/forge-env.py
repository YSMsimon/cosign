#!/usr/bin/env python3
"""Run arc-forge with .env.local loaded into the environment (never `source` .env files in a shell:
a value with a leading space gets executed as a command and printed)."""
import os, sys
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
env = dict(os.environ)
for line in open(os.path.join(root, ".env.local")):
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
os.execvpe("arc-forge", ["arc-forge", *sys.argv[1:]], env)
