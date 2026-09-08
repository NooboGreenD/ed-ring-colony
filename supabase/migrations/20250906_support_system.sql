-- ============================================
-- ED Ring Colony — Support System Migration
-- Tables: support_tickets, support_messages, support_attachments
-- Roles: admin, moderator, support_manager
-- ============================================

-- 1. Support tickets table
CREATE TABLE IF NOT EXISTS public.support_tickets (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title text NOT NULL,
  category text NOT NULL DEFAULT 'other' CHECK (category IN ('bug', 'feature_request', 'account_issue', 'other')),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'critical')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'waiting_user', 'resolved', 'closed')),
  assigned_to uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  page_url text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  resolved_at timestamptz,
  closed_at timestamptz
);

-- 2. Support messages table (threaded conversation)
CREATE TABLE IF NOT EXISTS public.support_messages (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  ticket_id uuid NOT NULL REFERENCES public.support_tickets(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content text NOT NULL,
  is_internal boolean NOT NULL DEFAULT false,
  read_at timestamptz,
  created_at timestamptz DEFAULT now()
);

-- 3. Support attachments table (screenshots, files)
CREATE TABLE IF NOT EXISTS public.support_attachments (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  ticket_id uuid NOT NULL REFERENCES public.support_tickets(id) ON DELETE CASCADE,
  message_id uuid REFERENCES public.support_messages(id) ON DELETE CASCADE,
  file_name text NOT NULL,
  file_type text NOT NULL,
  file_size integer NOT NULL,
  storage_path text NOT NULL,
  public_url text NOT NULL,
  uploaded_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now()
);

-- 4. Indexes for performance
CREATE INDEX IF NOT EXISTS idx_support_tickets_user_id ON public.support_tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON public.support_tickets(status);
CREATE INDEX IF NOT EXISTS idx_support_tickets_assigned_to ON public.support_tickets(assigned_to);
CREATE INDEX IF NOT EXISTS idx_support_tickets_created_at ON public.support_tickets(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_messages_ticket_id ON public.support_messages(ticket_id);
CREATE INDEX IF NOT EXISTS idx_support_messages_created_at ON public.support_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_support_attachments_ticket_id ON public.support_attachments(ticket_id);

-- 5. Updated_at trigger for support_tickets
CREATE OR REPLACE FUNCTION public.update_support_ticket_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_support_tickets_updated_at ON public.support_tickets;
CREATE TRIGGER trg_support_tickets_updated_at
  BEFORE UPDATE ON public.support_tickets
  FOR EACH ROW
  EXECUTE FUNCTION public.update_support_ticket_updated_at();

-- 6. RLS Policies
ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_attachments ENABLE ROW LEVEL SECURITY;

-- Tickets policies
DROP POLICY IF EXISTS support_tickets_user_select ON public.support_tickets;
DROP POLICY IF EXISTS support_tickets_user_insert ON public.support_tickets;
DROP POLICY IF EXISTS support_tickets_user_update ON public.support_tickets;
DROP POLICY IF EXISTS support_tickets_staff_select ON public.support_tickets;
DROP POLICY IF EXISTS support_tickets_staff_update ON public.support_tickets;

CREATE POLICY support_tickets_user_select ON public.support_tickets
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY support_tickets_user_insert ON public.support_tickets
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY support_tickets_user_update ON public.support_tickets
  FOR UPDATE USING (auth.uid() = user_id AND status IN ('open', 'waiting_user'));

CREATE POLICY support_tickets_staff_select ON public.support_tickets
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role IN ('admin', 'moderator', 'support_manager')
    )
  );

CREATE POLICY support_tickets_staff_update ON public.support_tickets
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role IN ('admin', 'moderator', 'support_manager')
    )
  );

-- Messages policies
DROP POLICY IF EXISTS support_messages_user_select ON public.support_messages;
DROP POLICY IF EXISTS support_messages_user_insert ON public.support_messages;
DROP POLICY IF EXISTS support_messages_staff_select ON public.support_messages;
DROP POLICY IF EXISTS support_messages_staff_insert ON public.support_messages;

CREATE POLICY support_messages_user_select ON public.support_messages
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.support_tickets t
      WHERE t.id = ticket_id AND t.user_id = auth.uid()
    ) AND is_internal = false
  );

CREATE POLICY support_messages_user_insert ON public.support_messages
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.support_tickets t
      WHERE t.id = ticket_id AND t.user_id = auth.uid()
    ) AND is_internal = false
  );

CREATE POLICY support_messages_staff_select ON public.support_messages
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role IN ('admin', 'moderator', 'support_manager')
    )
  );

CREATE POLICY support_messages_staff_insert ON public.support_messages
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role IN ('admin', 'moderator', 'support_manager')
    )
  );

-- Attachments policies
DROP POLICY IF EXISTS support_attachments_user_select ON public.support_attachments;
DROP POLICY IF EXISTS support_attachments_user_insert ON public.support_attachments;
DROP POLICY IF EXISTS support_attachments_staff_select ON public.support_attachments;
DROP POLICY IF EXISTS support_attachments_staff_insert ON public.support_attachments;

CREATE POLICY support_attachments_user_select ON public.support_attachments
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.support_tickets t
      WHERE t.id = ticket_id AND t.user_id = auth.uid()
    )
  );

CREATE POLICY support_attachments_user_insert ON public.support_attachments
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.support_tickets t
      WHERE t.id = ticket_id AND t.user_id = auth.uid()
    )
  );

CREATE POLICY support_attachments_staff_select ON public.support_attachments
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role IN ('admin', 'moderator', 'support_manager')
    )
  );

CREATE POLICY support_attachments_staff_insert ON public.support_attachments
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role IN ('admin', 'moderator', 'support_manager')
    )
  );

-- 7. Create storage bucket for support attachments
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'support-attachments',
  'support-attachments',
  true,
  5242880,
  ARRAY['image/jpeg','image/png','image/gif','image/webp','application/pdf','text/plain']
)
ON CONFLICT (id) DO NOTHING;

-- 8. Grant usage
GRANT ALL ON public.support_tickets TO service_role;
GRANT ALL ON public.support_messages TO service_role;
GRANT ALL ON public.support_attachments TO service_role;

-- 9. Function to notify staff on new ticket
CREATE OR REPLACE FUNCTION public.notify_staff_on_new_ticket()
RETURNS trigger AS $$
DECLARE
  staff_user_id uuid;
BEGIN
  FOR staff_user_id IN
    SELECT id FROM public.profiles WHERE role IN ('admin', 'moderator', 'support_manager')
  LOOP
    INSERT INTO public.user_notifications (user_id, type, title, body, href, metadata)
    VALUES (
      staff_user_id,
      'support_ticket',
      'Новое обращение в техподдержку',
      NEW.title,
      '/admin?tab=support',
      jsonb_build_object('ticket_id', NEW.id, 'user_id', NEW.user_id)
    );
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_notify_staff_new_ticket ON public.support_tickets;
CREATE TRIGGER trg_notify_staff_new_ticket
  AFTER INSERT ON public.support_tickets
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_staff_on_new_ticket();

-- 10. Function to notify user on staff reply
CREATE OR REPLACE FUNCTION public.notify_user_on_staff_reply()
RETURNS trigger AS $$
DECLARE
  ticket_user_id uuid;
  ticket_title text;
  sender_role text;
BEGIN
  SELECT t.user_id, t.title, p.role
  INTO ticket_user_id, ticket_title, sender_role
  FROM public.support_tickets t
  LEFT JOIN public.profiles p ON p.id = NEW.sender_id
  WHERE t.id = NEW.ticket_id;

  IF sender_role IN ('admin', 'moderator', 'support_manager') AND NEW.sender_id != ticket_user_id THEN
    INSERT INTO public.user_notifications (user_id, type, title, body, href, metadata)
    VALUES (
      ticket_user_id,
      'support_reply',
      'Ответ от техподдержки',
      ticket_title,
      '/support?t=' || NEW.ticket_id,
      jsonb_build_object('ticket_id', NEW.ticket_id, 'message_id', NEW.id)
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_notify_user_reply ON public.support_messages;
CREATE TRIGGER trg_notify_user_reply
  AFTER INSERT ON public.support_messages
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_user_on_staff_reply();
