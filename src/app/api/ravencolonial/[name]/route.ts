import { NextResponse } from "next/server";

const RC_API_BASE = "https://ravencolonial100-awcbdvabgze4c5cq.canadacentral-01.azurewebsites.net/api";

export async function GET(
  req: Request,
  { params }: { params: { name: string } }
) {
  const name = decodeURIComponent(params.name);
  if (!name) {
    return NextResponse.json({ error: "No CMDR name provided" }, { status: 400 });
  }

  try {
    // Use /refs endpoint — lightweight, returns all projects linked to CMDR
    const apiUrl = `${RC_API_BASE}/cmdr/${encodeURIComponent(name)}/refs`;
    const res = await fetch(apiUrl, {
      headers: { "Accept": "application/json" },
      next: { revalidate: 3600 },
    });

    if (!res.ok) {
      return NextResponse.json({
        totalSystems: 0,
        architectCount: 0,
        architectSystems: [],
        source: "ravencolonial_api",
        status: res.status,
      });
    }

    const data = await res.json();
    // data is an array of project refs
    const projects = Array.isArray(data) ? data : [];

    // Filter projects where this CMDR is the architect
    // architectName field contains the CMDR name who is architect
    const architectProjects = projects.filter(
      (p: any) => p.architectName && p.architectName.toLowerCase() === name.toLowerCase()
    );

    // Count unique systems (one system can have multiple builds/ports)
    const uniqueSystems = new Set(architectProjects.map((p: any) => p.systemName));

    return NextResponse.json({
      totalSystems: projects.length,
      architectCount: uniqueSystems.size,
      architectSystems: Array.from(uniqueSystems),
      projects: architectProjects.map((p: any) => ({
        systemName: p.systemName,
        buildName: p.buildName,
        complete: p.complete,
        architectName: p.architectName,
      })),
      source: "ravencolonial_api",
    });
  } catch (e: any) {
    return NextResponse.json({
      error: e.message || "Failed to fetch RavenColonial data",
      architectCount: 0,
      architectSystems: [],
      source: "error",
    }, { status: 500 });
  }
}
