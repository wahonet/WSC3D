"""Run the application with a local graceful-stop hook for restart and backup."""
import sys
from pathlib import Path
root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / 'src/backend'))
import uvicorn
from app.main import app
from app.config import settings
# On Windows a client reset makes asyncio's proactor transport raise before detaching from the
# server (WinError 10054 in _call_connection_lost), so Server.wait_closed() never returns.
# Bounding the graceful stop lets the lifespan still stop workers and release the workspace lock.
server = uvicorn.Server(uvicorn.Config(app, host=settings.host, port=settings.port, log_level='info',
                                       timeout_graceful_shutdown=5))
app.state.request_shutdown = lambda: setattr(server, 'should_exit', True)
if __name__ == '__main__':
    server.run()
