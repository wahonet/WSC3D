"""Run the application with a local graceful-stop hook for restart and backup."""
import sys
from pathlib import Path
root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / 'src/backend'))
import uvicorn
from app.main import app
from app.config import settings
server = uvicorn.Server(uvicorn.Config(app, host=settings.host, port=settings.port, log_level='info'))
app.state.request_shutdown = lambda: setattr(server, 'should_exit', True)
if __name__ == '__main__':
    server.run()
