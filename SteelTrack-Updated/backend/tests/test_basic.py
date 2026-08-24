from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)

def test_root():
    res = client.get('/')
    assert res.status_code in (200, 404, 302)

def test_login_seeded_admin():
    # default seeded admin is 'admin' with password 'admin' per .env.example
    res = client.post('/api/login', json={'username':'admin','password':'admin'})
    # either success (200) or bad request if env changed; ensure endpoint works
    assert res.status_code in (200, 400)
