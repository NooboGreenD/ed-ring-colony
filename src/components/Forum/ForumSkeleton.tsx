export function ForumSkeleton() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {[1, 2, 3].map((i) => (
        <div key={i} style={{ padding: "16px 20px", background: "#25282b", border: "1px solid #323538", borderRadius: 8 }}>
          <div className="skeleton-line" style={{ width: "30%", height: 18, marginBottom: 8 }} />
          <div className="skeleton-line" style={{ width: "60%", height: 14 }} />
        </div>
      ))}
    </div>
  );
}

export function ThreadSkeleton() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {[1, 2, 3, 4].map((i) => (
        <div key={i} style={{ padding: "14px 16px", background: "#25282b", border: "1px solid #323538", borderRadius: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <div className="skeleton-line" style={{ width: 32, height: 32, borderRadius: "50%" }} />
            <div className="skeleton-line" style={{ width: 120, height: 14 }} />
          </div>
          <div className="skeleton-line" style={{ width: "90%", height: 14, marginBottom: 6 }} />
          <div className="skeleton-line" style={{ width: "70%", height: 14 }} />
        </div>
      ))}
    </div>
  );
}
