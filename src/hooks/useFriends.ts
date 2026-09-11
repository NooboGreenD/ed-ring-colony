import { useState, useEffect, useCallback } from "react";
import { supabase, authFetch } from "@/lib/supabaseClient";
import type { Friend } from "@/types/friend";

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const body = await response.json();
    return body && typeof body === "object" ? body as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function useFriends(userId: string | null) {
  const [friends, setFriends] = useState<Friend[]>([]);
  const [pendingIncoming, setPendingIncoming] = useState<Friend[]>([]);
  const [pendingOutgoing, setPendingOutgoing] = useState<Friend[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadFriends = useCallback(async () => {
    if (!userId) {
      setFriends([]);
      setPendingIncoming([]);
      setPendingOutgoing([]);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const [acceptedResponse, pendingResponse] = await Promise.all([
        authFetch("/api/friends?status=accepted", { cache: "no-store" }),
        authFetch("/api/friends?status=pending", { cache: "no-store" }),
      ]);
      const [acceptedJson, pendingJson] = await Promise.all([
        responseJson(acceptedResponse),
        responseJson(pendingResponse),
      ]);
      const errors: string[] = [];

      if (!acceptedResponse.ok) {
        const message = typeof acceptedJson.error === "string" ? acceptedJson.error : "Не удалось загрузить список друзей";
        console.error("[useFriends] GET accepted error:", message);
        errors.push(message);
      } else {
        setFriends(Array.isArray(acceptedJson.friends) ? acceptedJson.friends as Friend[] : []);
      }

      if (!pendingResponse.ok) {
        const message = typeof pendingJson.error === "string" ? pendingJson.error : "Не удалось загрузить запросы в друзья";
        console.error("[useFriends] GET pending error:", message);
        errors.push(message);
      } else {
        const allPending = Array.isArray(pendingJson.friends) ? pendingJson.friends as Friend[] : [];
        setPendingIncoming(allPending.filter((friend) => friend.addressee_id === userId));
        setPendingOutgoing(allPending.filter((friend) => friend.requester_id === userId));
      }

      // Preserve any last successful data on a transient failure instead of
      // presenting the user with a misleading empty friends list.
      setError(errors.length ? errors.join(". ") : null);
    } catch (loadError) {
      console.error("[useFriends] loadFriends exception:", loadError);
      setError("Не удалось связаться с сервером друзей");
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void loadFriends();
  }, [loadFriends]);

  useEffect(() => {
    if (!userId) return;
    const channel = supabase
      .channel(`friends_${userId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "friends", filter: `requester_id=eq.${userId}` }, () => void loadFriends())
      .on("postgres_changes", { event: "*", schema: "public", table: "friends", filter: `addressee_id=eq.${userId}` }, () => void loadFriends())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [userId, loadFriends]);

  const sendRequest = async (addresseeId: string) => {
    const response = await authFetch("/api/friends", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ addressee_id: addresseeId }),
    });
    const data = await responseJson(response);
    if (response.ok) void loadFriends();
    return { ok: response.ok, data, status: response.status };
  };

  const acceptRequest = async (friendId: number | { requester_id: string; addressee_id: string }) => {
    const body = typeof friendId === "number" ? { id: friendId, status: "accepted" } : { ...friendId, status: "accepted" };
    const response = await authFetch("/api/friends", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.ok) void loadFriends();
    return response.ok;
  };

  const rejectRequest = async (friendId: number | { requester_id: string; addressee_id: string }) => {
    const body = typeof friendId === "number" ? { id: friendId } : friendId;
    const response = await authFetch("/api/friends", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.ok) void loadFriends();
    return response.ok;
  };

  const removeFriend = async (friendId: number) => rejectRequest(friendId);

  const isFriend = useCallback((otherId: string) => (
    friends.some((friend) => friend.friend_id === otherId)
  ), [friends]);

  const hasPending = useCallback((otherId: string) => (
    pendingOutgoing.some((friend) => friend.addressee_id === otherId)
    || pendingIncoming.some((friend) => friend.requester_id === otherId)
  ), [pendingOutgoing, pendingIncoming]);

  const isPendingIncoming = useCallback((otherId: string) => (
    pendingIncoming.some((friend) => friend.requester_id === otherId)
  ), [pendingIncoming]);

  return {
    friends,
    pendingIncoming,
    pendingOutgoing,
    loading,
    error,
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
