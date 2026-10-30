"""Runs the test suite against src/ without installing (CI and local)."""
import pathlib
import sys
import unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "src"))
suite = unittest.defaultTestLoader.discover(str(HERE / "tests"), top_level_dir=str(HERE / "tests"))
result = unittest.TextTestRunner(verbosity=1).run(suite)
sys.exit(0 if result.wasSuccessful() else 1)
