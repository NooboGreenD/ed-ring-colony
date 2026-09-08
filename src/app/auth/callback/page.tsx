'use client';

import { useEffect } from 'react';

// This page is a fallback. Normal OAuth flow goes through /api/auth/callback.
export default function AuthCallbackPage() {
  useEffect(() => {
    // If user lands here directly, redirect to login
    window.location.href = '/login';
  }, []);

  return (
    <main className="card auth-card">
      <p>Переадресация...</p>
    </main>
  );
}
