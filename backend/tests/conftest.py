"""
Runs before any test module is imported: point the app at a throwaway SQLite file and switch off
auth and Gemini, so `pytest` never touches your real PostgreSQL database or the network.
"""
import os
import tempfile

_tmp = tempfile.mkdtemp(prefix="fraudgraph_test_")
os.environ["DATABASE_URL"] = f"sqlite:///{os.path.join(_tmp, 'test.db')}"
os.environ["API_KEY"] = ""
os.environ["GEMINI_API_KEY"] = ""
os.environ["CORS_ORIGINS"] = "http://localhost:3000"
