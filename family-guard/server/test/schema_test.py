import sqlite3
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class FamilyGuardSchemaTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.executescript((ROOT / "schema.sql").read_text(encoding="utf-8"))

    def tearDown(self):
        self.db.close()

    def migrate(self):
        self.db.executescript((ROOT / "migrations" / "0002_multi_parent.sql").read_text(encoding="utf-8"))

    def test_migration_preserves_existing_owner_token(self):
        self.db.execute(
            "INSERT INTO families(id,parent_label,parent_token_hash,created_at) VALUES(?,?,?,?)",
            ("family-1", "Parent", "existing-parent-token-hash", "2026-01-01T00:00:00Z"),
        )
        self.migrate()
        owner = self.db.execute(
            "SELECT family_id,role,label,token_hash,status,subscription_status FROM family_members"
        ).fetchone()
        self.assertEqual(owner, ("family-1", "owner", "Parent", "existing-parent-token-hash", "active", "included"))

    def test_only_one_active_second_parent_per_family(self):
        self.db.execute(
            "INSERT INTO families(id,parent_label,parent_token_hash,created_at) VALUES(?,?,?,?)",
            ("family-2", "Parent", "owner-hash", "2026-01-01T00:00:00Z"),
        )
        self.migrate()
        self.db.execute(
            "INSERT INTO family_members(id,family_id,role,label,token_hash,status,subscription_status,created_at) VALUES(?,?,?,?,?,?,?,?)",
            ("p2-a", "family-2", "second_parent", "Second A", "token-a", "active", "inactive", "2026-01-01T00:00:00Z"),
        )
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                "INSERT INTO family_members(id,family_id,role,label,token_hash,status,subscription_status,created_at) VALUES(?,?,?,?,?,?,?,?)",
                ("p2-b", "family-2", "second_parent", "Second B", "token-b", "active", "inactive", "2026-01-01T00:00:00Z"),
            )

    def test_revoked_second_parent_can_be_replaced(self):
        self.db.execute(
            "INSERT INTO families(id,parent_label,parent_token_hash,created_at) VALUES(?,?,?,?)",
            ("family-3", "Parent", "owner-hash-3", "2026-01-01T00:00:00Z"),
        )
        self.migrate()
        self.db.execute(
            "INSERT INTO family_members(id,family_id,role,label,token_hash,status,subscription_status,created_at) VALUES(?,?,?,?,?,?,?,?)",
            ("p2-old", "family-3", "second_parent", "Old", "token-old", "revoked", "inactive", "2026-01-01T00:00:00Z"),
        )
        self.db.execute(
            "INSERT INTO family_members(id,family_id,role,label,token_hash,status,subscription_status,created_at) VALUES(?,?,?,?,?,?,?,?)",
            ("p2-new", "family-3", "second_parent", "New", "token-new", "active", "inactive", "2026-01-02T00:00:00Z"),
        )
        self.assertEqual(self.db.execute(
            "SELECT COUNT(*) FROM family_members WHERE family_id=? AND role='second_parent' AND status='active'",
            ("family-3",),
        ).fetchone()[0], 1)

    def test_device_and_location_foreign_keys_and_coordinates_storage(self):
        self.db.execute(
            "INSERT INTO families(id,parent_label,parent_token_hash,created_at) VALUES(?,?,?,?)",
            ("family-4", "Parent", "owner-hash-4", "2026-01-01T00:00:00Z"),
        )
        self.db.execute(
            "INSERT INTO devices(id,family_id,label,device_token_hash,consented_at,sharing_enabled,created_at) VALUES(?,?,?,?,?,?,?)",
            ("device-4", "family-4", "Child phone", "device-hash", "2026-01-01T00:00:00Z", 1, "2026-01-01T00:00:00Z"),
        )
        self.db.execute(
            "INSERT INTO locations(device_id,latitude,longitude,accuracy_m,recorded_at,received_at) VALUES(?,?,?,?,?,?)",
            ("device-4", 35.5, 54.2, 8.0, "2026-01-01T00:01:00Z", "2026-01-01T00:01:01Z"),
        )
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM locations").fetchone()[0], 1)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                "INSERT INTO locations(device_id,latitude,longitude,recorded_at,received_at) VALUES(?,?,?,?,?)",
                ("missing-device", 35.5, 54.2, "2026-01-01T00:01:00Z", "2026-01-01T00:01:01Z"),
            )


if __name__ == "__main__":
    unittest.main()
