-- Fix: ensure friends table exists (in case 023 failed partially)

CREATE TABLE IF NOT EXISTS friends (
  id bigint generated always as identity primary key,
  requester_id uuid not null references auth.users(id) on delete cascade,
  addressee_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','accepted','blocked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Unique constraint via index (safer than table-level unique with functions)
CREATE UNIQUE INDEX IF NOT EXISTS idx_friends_unique_pair ON friends 
  USING btree (LEAST(requester_id, addressee_id), GREATEST(requester_id, addressee_id));

-- Indexes
CREATE INDEX IF NOT EXISTS idx_friends_requester ON friends(requester_id);
CREATE INDEX IF NOT EXISTS idx_friends_addressee ON friends(addressee_id);
CREATE INDEX IF NOT EXISTS idx_friends_status ON friends(status);

-- Trigger for updated_at
CREATE OR REPLACE FUNCTION update_friends_updated_at()
RETURNS trigger AS $$
BEGIN
  new.updated_at = now();
  RETURN new;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tr_friends_updated_at ON friends;
CREATE TRIGGER tr_friends_updated_at
  BEFORE UPDATE ON friends
  FOR EACH ROW EXECUTE FUNCTION update_friends_updated_at();

-- RLS
ALTER TABLE friends ENABLE ROW LEVEL SECURITY;

-- Drop existing policies to avoid conflicts
DROP POLICY IF EXISTS friends_select_own ON friends;
DROP POLICY IF EXISTS friends_insert_own ON friends;
DROP POLICY IF EXISTS friends_update_own ON friends;
DROP POLICY IF EXISTS friends_delete_own ON friends;

CREATE POLICY friends_select_own ON friends
  FOR SELECT USING (auth.uid() = requester_id OR auth.uid() = addressee_id);

CREATE POLICY friends_insert_own ON friends
  FOR INSERT WITH CHECK (auth.uid() = requester_id);

CREATE POLICY friends_update_own ON friends
  FOR UPDATE USING (auth.uid() = addressee_id OR auth.uid() = requester_id);

CREATE POLICY friends_delete_own ON friends
  FOR DELETE USING (auth.uid() = requester_id OR auth.uid() = addressee_id);

-- View
CREATE OR REPLACE VIEW friend_profiles AS
SELECT
  f.id,
  f.requester_id,
  f.addressee_id,
  f.status,
  f.created_at,
  f.updated_at,
  CASE WHEN f.requester_id = auth.uid() THEN p2.cmdr_name ELSE p1.cmdr_name END AS friend_name,
  CASE WHEN f.requester_id = auth.uid() THEN p2.avatar_url ELSE p1.avatar_url END AS friend_avatar,
  CASE WHEN f.requester_id = auth.uid() THEN p2.id ELSE p1.id END AS friend_id
FROM friends f
LEFT JOIN profiles p1 ON p1.id = f.requester_id
LEFT JOIN profiles p2 ON p2.id = f.addressee_id
WHERE f.status = 'accepted';

-- Function
CREATE OR REPLACE FUNCTION get_friend_ids(user_uuid uuid)
RETURNS TABLE(friend_id uuid) AS $$
BEGIN
  RETURN QUERY
  SELECT CASE
    WHEN f.requester_id = user_uuid THEN f.addressee_id
    ELSE f.requester_id
  END
  FROM friends f
  WHERE f.status = 'accepted'
    AND (f.requester_id = user_uuid OR f.addressee_id = user_uuid);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
