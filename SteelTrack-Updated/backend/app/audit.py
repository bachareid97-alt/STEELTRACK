import os
import json
from datetime import datetime
from typing import Optional

from sqlalchemy import create_engine, Column, Integer, String, Text, DateTime, ForeignKey
from sqlalchemy.orm import declarative_base, sessionmaker, relationship

DATABASE_URL = os.environ.get('DATABASE_URL', 'sqlite:///./data/steeltrack.db')
if DATABASE_URL.startswith('sqlite'):
    engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
else:
    engine = create_engine(DATABASE_URL)
SessionLocal = sessionmaker(bind=engine)
Base = declarative_base()

class AuditLog(Base):
    __tablename__ = 'audit_log'
    id = Column(Integer, primary_key=True)
    table_name = Column(String(100), nullable=False)
    record_id = Column(Integer, nullable=True)
    action = Column(String(50), nullable=False)
    old_value = Column(Text, nullable=True)
    new_value = Column(Text, nullable=True)
    user_id = Column(Integer, nullable=True)
    timestamp = Column(DateTime, default=datetime.utcnow)

def record_audit(table_name: str, record_id: Optional[int], action: str, old, new, user_id: Optional[int]=None):
    db = SessionLocal()
    try:
        a = AuditLog(table_name=table_name, record_id=record_id, action=action, old_value=json.dumps(old) if old is not None else None, new_value=json.dumps(new) if new is not None else None, user_id=user_id, timestamp=datetime.utcnow())
        db.add(a)
        db.commit()
    finally:
        db.close()
