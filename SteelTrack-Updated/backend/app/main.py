import os
import json
import time
from datetime import datetime, timedelta
from typing import Dict, Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Depends, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy import create_engine, Column, Integer, String, Text, DateTime, ForeignKey
from sqlalchemy.orm import sessionmaker, declarative_base, Session, relationship
from passlib.context import CryptContext
import jwt

DATABASE_URL = os.environ.get("DATABASE_URL", "sqlite:///./data/steeltrack.db")
JWT_SECRET = os.environ.get("JWT_SECRET", "change-this-secret")
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 8

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# --- Models ---
class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, unique=True, index=True, nullable=False)
    hashed_password = Column(String, nullable=False)
    role = Column(String, default="viewer")

class KV(Base):
    __tablename__ = "kv"
    id = Column(Integer, primary_key=True, index=True)
    key = Column(String, unique=True, index=True, nullable=False)
    value = Column(Text)
    version = Column(Integer, default=1)
    last_updated = Column(DateTime, default=datetime.utcnow)
    last_updated_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    user = relationship("User", lazy="joined")

Base.metadata.create_all(bind=engine)

# --- Utilities ---
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def verify_password(plain, hashed):
    return pwd_context.verify(plain, hashed)


def get_password_hash(password):
    return pwd_context.hash(password)


def create_access_token(data: dict, expires_delta: timedelta | None = None):
    to_encode = data.copy()
    if expires_delta:
        expire = datetime.utcnow() + expires_delta
    else:
        expire = datetime.utcnow() + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, JWT_SECRET, algorithm="HS256")
    return encoded_jwt


def decode_token(token: str):
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])  # raises on invalid/expired
        return payload
    except Exception:
        return None

# --- App ---
app = FastAPI(title="SteelTrack Backend (MVP)")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Seed admin user if not present
def seed_admin():
    db = SessionLocal()
    admin_user = os.environ.get("ADMIN_USER", "admin")
    admin_pass = os.environ.get("ADMIN_PASS", "admin")
    try:
        u = db.query(User).filter(User.username == admin_user).first()
        if not u:
            user = User(username=admin_user, hashed_password=get_password_hash(admin_pass), role="admin")
            db.add(user)
            db.commit()
            print(f"Seeded admin user: {admin_user}")
    finally:
        db.close()

seed_admin()

# --- Schemas ---
class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"

class LoginPayload(BaseModel):
    username: str
    password: str

# --- Auth dependencies ---

def get_current_user(token: str = None, db: Session = Depends(get_db)):
    if token is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing token")
    payload = decode_token(token)
    if not payload or "sub" not in payload:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
    username = payload["sub"]
    user = db.query(User).filter(User.username == username).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    return user

# --- HTTP endpoints ---
@app.post("/api/login", response_model=Token)
def login(p: LoginPayload, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.username == p.username).first()
    if not user or not verify_password(p.password, user.hashed_password):
        raise HTTPException(status_code=400, detail="Incorrect username or password")
    access_token = create_access_token({"sub": user.username})
    return {"access_token": access_token, "token_type": "bearer"}

@app.get("/api/me")
def me(current: User = Depends(lambda token=None, db=Depends(get_db): get_current_user(token, db))):
    return {"username": current.username, "role": current.role}

# --- WebSocket manager ---
class ConnectionManager:
    def __init__(self):
        self.active_connections: Dict[WebSocket, Dict[str, Any]] = {}

    async def connect(self, websocket: WebSocket, user: User):
        await websocket.accept()
        self.active_connections[websocket] = {"user": user}

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            del self.active_connections[websocket]

    async def send_personal_message(self, message: dict, websocket: WebSocket):
        await websocket.send_text(json.dumps(message))

    async def broadcast(self, message: dict, exclude: WebSocket | None = None):
        text = json.dumps(message)
        dead = []
        for ws in list(self.active_connections.keys()):
            if ws is exclude:
                continue
            try:
                await ws.send_text(text)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)

manager = ConnectionManager()

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    # Expect token as query param or header
    token = websocket.query_params.get("token") or websocket.headers.get("authorization")
    if token and token.lower().startswith("bearer "):
        token = token.split(" ", 1)[1]
    db = SessionLocal()
    try:
        payload = decode_token(token) if token else None
        if not payload or "sub" not in payload:
            await websocket.close(code=1008)
            return
        username = payload["sub"]
        user = db.query(User).filter(User.username == username).first()
        if not user:
            await websocket.close(code=1008)
            return
        await manager.connect(websocket, user)
        # Send hello with full store
        store = {row.key: row.value for row in db.query(KV).all()}
        await manager.send_personal_message({"type": "hello", "store": store}, websocket)

        while True:
            data = await websocket.receive_text()
            try:
                msg = json.loads(data)
            except Exception:
                continue
            mtype = msg.get("type")
            if mtype == "set":
                key = msg.get("key")
                value = msg.get("value")
                if key is None:
                    continue
                # Upsert in DB synchronously
                row = db.query(KV).filter(KV.key == key).first()
                if row:
                    row.value = value
                    row.version = (row.version or 1) + 1
                    row.last_updated = datetime.utcnow()
                    row.last_updated_by = user.id
                else:
                    row = KV(key=key, value=value, version=1, last_updated=datetime.utcnow(), last_updated_by=user.id)
                    db.add(row)
                db.commit()
                # Broadcast to others
                out = {"type": "set", "key": key, "value": value, "version": row.version, "by": user.username, "ts": datetime.utcnow().isoformat()}
                await manager.broadcast(out, exclude=websocket)
            elif mtype == "remove":
                key = msg.get("key")
                if key is None:
                    continue
                row = db.query(KV).filter(KV.key == key).first()
                if row:
                    db.delete(row)
                    db.commit()
                out = {"type": "remove", "key": key, "by": user.username, "ts": datetime.utcnow().isoformat()}
                await manager.broadcast(out, exclude=websocket)
            # other message types can be handled here

    except WebSocketDisconnect:
        manager.disconnect(websocket)
    finally:
        db.close()
