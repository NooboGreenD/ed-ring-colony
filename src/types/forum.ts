export interface ForumCategory {
  id: number;
  name: string;
  slug: string;
  description: string;
  sort_order: number;
  forum_threads?: { count: number }[];
}

export interface ForumThread {
  id: number;
  title: string;
  author_id: string;
  author_name: string;
  category_id: number;
  is_pinned: boolean;
  is_locked: boolean;
  views: number;
  created_at: string;
  updated_at: string;
  last_post_at?: string;
  last_post_author?: string;
  forum_posts?: { count: number }[];
}

export interface ForumPost {
  id: number;
  content: string;
  author_id: string;
  author_name: string;
  thread_id: number;
  created_at: string;
  updated_at: string;
  is_deleted: boolean;
  author?: { cmdr_name: string; avatar_url: string | null };
}

export interface ForumReaction {
  id: number;
  post_id: number;
  user_id: string;
  emoji: string;
}

// === Дополнения ===

export interface ForumTag {
  id: number;
  name: string;
  slug: string;
  color: string;
}

export interface ForumReport {
  id: number;
  reporter_id: string;
  post_id?: number;
  thread_id?: number;
  reason: string;
  status: 'open' | 'reviewed' | 'dismissed' | 'resolved';
  moderator_note?: string;
  created_at: string;
  resolved_at?: string;
}

export interface ForumPostWithParent extends ForumPost {
  parent_post_id?: number | null;
  is_edited: boolean;
  replies?: ForumPostWithParent[];
}

export interface UserBadge {
  id: string;
  user_id: string;
  badge_id: number;
  awarded_at: string;
}

export interface ProfilePublic {
  id: string;
  cmdr_name?: string;
  avatar_url?: string | null;
  bio?: string;
  squadron?: string;
  total_delivered: number;
  hubs_visited: number;
  forum_posts_count: number;
  last_active_at?: string;
  badges?: UserBadge[];
}
