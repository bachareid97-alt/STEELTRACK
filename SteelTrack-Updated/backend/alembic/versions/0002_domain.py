"""
Alembic migration: add domain tables (jobs, parts, stock_entries, audit_log, attachments)
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = '0002_domain'
down_revision = '0001_initial'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'jobs',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('jo_number', sa.String(length=100), nullable=False, unique=True, index=True),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('status', sa.String(length=50), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.Column('updated_at', sa.DateTime(), nullable=True),
    )

    op.create_table(
        'parts',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('part_number', sa.String(length=100), nullable=False, unique=True, index=True),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.Column('updated_at', sa.DateTime(), nullable=True),
    )

    op.create_table(
        'stock_entries',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('part_id', sa.Integer(), sa.ForeignKey('parts.id'), nullable=False),
        sa.Column('quantity', sa.Integer(), nullable=False),
        sa.Column('location', sa.String(length=200), nullable=True),
        sa.Column('last_updated', sa.DateTime(), nullable=True),
    )

    op.create_table(
        'audit_log',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('table_name', sa.String(length=100), nullable=False),
        sa.Column('record_id', sa.Integer(), nullable=True),
        sa.Column('action', sa.String(length=50), nullable=False),
        sa.Column('old_value', sa.Text(), nullable=True),
        sa.Column('new_value', sa.Text(), nullable=True),
        sa.Column('user_id', sa.Integer(), sa.ForeignKey('users.id'), nullable=True),
        sa.Column('timestamp', sa.DateTime(), nullable=True),
    )

    op.create_table(
        'attachments',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('filename', sa.String(length=255), nullable=False),
        sa.Column('s3_key', sa.String(length=1024), nullable=False),
        sa.Column('content_type', sa.String(length=255), nullable=True),
        sa.Column('size', sa.Integer(), nullable=True),
        sa.Column('uploaded_by', sa.Integer(), sa.ForeignKey('users.id'), nullable=True),
        sa.Column('uploaded_at', sa.DateTime(), nullable=True),
    )


def downgrade():
    op.drop_table('attachments')
    op.drop_table('audit_log')
    op.drop_table('stock_entries')
    op.drop_table('parts')
    op.drop_table('jobs')
