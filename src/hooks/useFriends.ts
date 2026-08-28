import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabaseClient";
import type { Friend } from "@/types/friend";

export function useFriends(userId: string | null) {
  const [friends, setFriends] = useState<Friend[]>([]);
  const [pendingIncoming, setPendingIncoming] = useState<Friend[]>([]);
  const [pendingOutgoing, setPendingOutgoing] = useState<Friend[]>([]);
  const [loading, setLoading] = useState(false);

  const loadFriends = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    try {
      const res = await fetch("/api/friends?status=accepted", { credentials: "include" });
      const json = await res.json();
      if (!res.ok) {
        console.error("[useFriends] GET accepted error:", json.error);
        setFriends([]);
      } else {
        setFriends(json.friends || []);
      }

      const resPending = await fetch("/api/friends?status=pending", { credentials: "include" });
      const jsonPending = await resPending.json();
      if (!resPending.ok) {
        console.error("[useFriends] GET pending error:", jsonPending.error);
        setPendingIncoming([]);
        setPendingOutgoing([]);
      } else {
        const allPending = jsonPending.friends || [];
        setPendingIncoming(allPending.filter((f: Friend) => f.addressee_id === userId));
        setPendingOutgoing(allPending.filter((f: Friend) => f.requester_id === userId));
      }
    } catch (e) {
      console.error("[useFriends] loadFriends exception:", e);
    }
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    loadFriends();
  }, [loadFriends]);

  useEffect(() => {
    if (!userId) return;
    const channel = supabase
      .channel(`friends_${userId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "friends", filter: `requester_id=eq.${userId}` }, () => loadFriends())
      .on("postgres_changes", { event: "*", schema: "public", table: "friends", filter: `addressee_id=eq.${userId}` }, () => loadFriends())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [userId, loadFriends]);

  const sendRequest = async (addresseeId: string) => {
    const res = await fetch("/api/friends", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ addressee_id: addresseeId }),
    });
    const json = await res.json();
    if (res.ok) loadFriends();
    return { ok: res.ok, data: json, status: res.status };
  };

  const acceptRequest = async (friendId: number | { requester_id: string; addressee_id: string }) => {
    const body = typeof friendId === "number" ? { id: friendId, status: "accepted" } : { ...friendId, status: "accepted" };
    const res = await fetch("/api/friends", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    });
    if (res.ok) loadFriends();
    return res.ok;
  };

  const rejectRequest = async (friendId: number | { requester_id: string; addressee_id: string }) => {
    const body = typeof friendId === "number" ? { id: friendId } : friendId;
    const res = await fetch("/api/friends", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    });
    if (res.ok) loadFriends();
    return res.ok;
  };

  const removeFriend = async (friendId: number) => {
    return rejectRequest(friendId);
  };

  const isFriend = useCallback((otherId: string) => {
    return friends.some((f) => f.friend_id === otherId);
  }, [friends]);

  const hasPending = useCallback((otherId: string) => {
    return pendingOutgoing.some((f) => f.addressee_id === otherId) || pendingIncoming.some((f) => f.requester_id === otherId);
  }, [pendingOutgoing, pendingIncoming]);

  const isPendingIncoming = useCallback((otherId: string) => {
    return pendingIncoming.some((f) => f.requester_id === otherId);
  }, [pendingIncoming]);

  return {
    friends,
    pendingIncoming,
    pendingOutgoing,
    loading,
    sendRequest,
    acceptRequest,
    rejectRequest,
    removeFriend,
    isFriend,
    hasPending,
    isPendingIncoming,
    refresh: loadFriends,
  };
}
