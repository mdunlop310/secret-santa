"""group codewords and optional participant emails

Revision ID: 0006
Revises: 0005
Create Date: 2026-11-13
"""

import secrets
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0006"
down_revision: str | None = "0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("groups", sa.Column("codeword", sa.String(40), nullable=True))
    op.add_column("groups", sa.Column("codeword_key", sa.String(40), nullable=True))
    # Existing groups get a random codeword the organiser can see and change.
    conn = op.get_bind()
    for (group_id,) in conn.execute(sa.text("SELECT id FROM groups")).all():
        word = f"santa{secrets.token_hex(4)}"
        conn.execute(
            sa.text("UPDATE groups SET codeword = :w, codeword_key = :w WHERE id = :id"),
            {"w": word, "id": group_id},
        )
    op.alter_column("groups", "codeword", nullable=False)
    op.alter_column("groups", "codeword_key", nullable=False)
    op.create_unique_constraint("uq_groups_codeword_key", "groups", ["codeword_key"])
    op.alter_column("participants", "email", existing_type=sa.String(254), nullable=True)


def downgrade() -> None:
    op.execute("DELETE FROM participants WHERE email IS NULL")
    op.alter_column("participants", "email", existing_type=sa.String(254), nullable=False)
    op.drop_constraint("uq_groups_codeword_key", "groups", type_="unique")
    op.drop_column("groups", "codeword_key")
    op.drop_column("groups", "codeword")
