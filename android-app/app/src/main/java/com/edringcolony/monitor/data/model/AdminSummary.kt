package com.edringcolony.monitor.data.model

import com.google.gson.annotations.SerializedName

data class AdminSummaryResponse(
    @SerializedName("success") val success: Boolean,
    @SerializedName("checkedAt") val checkedAt: String?,
    @SerializedName("overview") val overview: Overview?,
    @SerializedName("monitor") val monitor: ServerMonitorSnapshot?,
    @SerializedName("billing") val billing: BillingStats?,
    @SerializedName("lists") val lists: Lists?,
    @SerializedName("content") val content: Map<String, Any?>?,
    @SerializedName("flags") val flags: List<Map<String, Any?>>?,
    @SerializedName("health") val health: Health?,
    @SerializedName("error") val error: String?
)

data class Overview(
    @SerializedName("profiles") val profiles: Int?,
    @SerializedName("hubs") val hubs: Int?,
    @SerializedName("routeSystems") val routeSystems: Int?,
    @SerializedName("news") val news: Int?,
    @SerializedName("forumThreads") val forumThreads: Int?,
    @SerializedName("forumPosts") val forumPosts: Int?,
    @SerializedName("comments") val comments: Int?,
    @SerializedName("ticketsOpen") val ticketsOpen: Int?,
    @SerializedName("ticketsTotal") val ticketsTotal: Int?,
    @SerializedName("apiTokens") val apiTokens: Int?,
    @SerializedName("galaxySystems") val galaxySystems: Int?,
    @SerializedName("galnetPending") val galnetPending: Int?
)

data class Health(
    @SerializedName("overall") val overall: String?,
    @SerializedName("app") val app: String?,
    @SerializedName("database") val database: String?,
    @SerializedName("docker") val docker: String?,
    @SerializedName("disk") val disk: String?,
    @SerializedName("project") val project: String?
)

data class Lists(
    @SerializedName("hubs") val hubs: List<Hub>?,
    @SerializedName("routeSystems") val routeSystems: List<RouteSystem>?,
    @SerializedName("recentNews") val recentNews: List<NewsItem>?,
    @SerializedName("backupLog") val backupLog: List<Map<String, Any?>>?
)

data class Hub(
    @SerializedName("id") val id: Int,
    @SerializedName("name") val name: String?,
    @SerializedName("system_name") val systemName: String?,
    @SerializedName("status") val status: String?,
    @SerializedName("segment_order") val segmentOrder: Int?,
    @SerializedName("x") val x: Double?,
    @SerializedName("y") val y: Double?,
    @SerializedName("z") val z: Double?
)

data class RouteSystem(
    @SerializedName("id") val id: Int,
    @SerializedName("system_name") val systemName: String?,
    @SerializedName("status") val status: String?,
    @SerializedName("progress") val progress: Int?,
    @SerializedName("sort_order") val sortOrder: Int?,
    @SerializedName("x") val x: Double?,
    @SerializedName("y") val y: Double?,
    @SerializedName("z") val z: Double?
)

data class NewsItem(
    @SerializedName("id") val id: Int,
    @SerializedName("title") val title: String?,
    @SerializedName("published_at") val publishedAt: String?,
    @SerializedName("translation_status") val translationStatus: String?
)

// Billing minimal
data class BillingStats(
    @SerializedName("revenue") val revenue: Revenue?,
    @SerializedName("transactions") val transactions: CountWrapper?,
    @SerializedName("subscriptions") val subscriptions: SubscriptionStats?,
    @SerializedName("telemetry") val telemetry: Telemetry?,
    @SerializedName("topProducts") val topProducts: List<TopProduct>?
)

data class Revenue(
    @SerializedName("total") val total: Double?,
    @SerializedName("avgCheck") val avgCheck: Double?,
    @SerializedName("arpu") val arpu: Double?
)

data class CountWrapper(
    @SerializedName("total") val total: Int?
)

data class SubscriptionStats(
    @SerializedName("active") val active: Int?,
    @SerializedName("churnRate") val churnRate: Double?
)

data class Telemetry(
    @SerializedName("totalRegisteredPilots") val totalRegisteredPilots: Int?,
    @SerializedName("totalSystemsClaimed") val totalSystemsClaimed: Int?,
    @SerializedName("totalFacilitiesBuilt") val totalFacilitiesBuilt: Int?,
    @SerializedName("totalTonnageHauled") val totalTonnageHauled: Double?,
    @SerializedName("supportTicketsOpen") val supportTicketsOpen: Int?,
    @SerializedName("apiTokensActive") val apiTokensActive: Int?
)

data class TopProduct(
    @SerializedName("id") val id: String?,
    @SerializedName("name") val name: String?,
    @SerializedName("sales") val sales: Int?,
    @SerializedName("count") val count: Int?
)

// Monitor snapshot (partial)
data class ServerMonitorSnapshot(
    @SerializedName("checkedAt") val checkedAt: String?,
    @SerializedName("overall") val overall: String?,
    @SerializedName("application") val application: AppInfo?,
    @SerializedName("database") val database: DatabaseInfo?,
    @SerializedName("disk") val disk: DiskInfo?,
    @SerializedName("docker") val docker: DockerInfo?,
    @SerializedName("scheduler") val scheduler: SchedulerInfo?,
    @SerializedName("content") val content: ContentPipeline?,
    @SerializedName("project") val project: ProjectInfo?
)

data class AppInfo(
    @SerializedName("uptimeSeconds") val uptimeSeconds: Long?,
    @SerializedName("nodeVersion") val nodeVersion: String?,
    @SerializedName("memory") val memory: MemoryInfo?
)

data class MemoryInfo(
    @SerializedName("rssBytes") val rssBytes: Long?,
    @SerializedName("heapUsedBytes") val heapUsedBytes: Long?
)

data class DatabaseInfo(
    @SerializedName("status") val status: String?,
    @SerializedName("latencyMs") val latencyMs: Long?,
    @SerializedName("size") val size: DatabaseSize?
)

data class DatabaseSize(
    @SerializedName("databaseBytes") val databaseBytes: Long?,
    @SerializedName("largest") val largest: List<DbTable>?
)

data class DbTable(
    @SerializedName("name") val name: String?,
    @SerializedName("totalBytes") val totalBytes: Long?,
    @SerializedName("liveRows") val liveRows: Long?,
    @SerializedName("kind") val kind: String?
)

data class DiskInfo(
    @SerializedName("available") val available: Boolean?,
    @SerializedName("usedPercent") val usedPercent: Double?,
    @SerializedName("availableBytes") val availableBytes: Long?,
    @SerializedName("totalBytes") val totalBytes: Long?
)

data class DockerInfo(
    @SerializedName("available") val available: Boolean?,
    @SerializedName("containers") val containers: List<Container>?
)

data class Container(
    @SerializedName("service") val service: String?,
    @SerializedName("state") val state: String?,
    @SerializedName("health") val health: String?,
    @SerializedName("restartCount") val restartCount: Int?
)

data class SchedulerInfo(
    @SerializedName("available") val available: Boolean?,
    @SerializedName("jobs") val jobs: List<Job>?
)

data class Job(
    @SerializedName("name") val name: String?,
    @SerializedName("status") val status: String?,
    @SerializedName("lastSuccessAt") val lastSuccessAt: String?,
    @SerializedName("nextRunAt") val nextRunAt: String?,
    @SerializedName("lastError") val lastError: String?
)

data class ContentPipeline(
    @SerializedName("available") val available: Boolean?,
    @SerializedName("translateConfigured") val translateConfigured: Boolean?,
    @SerializedName("pendingTotal") val pendingTotal: Int?,
    @SerializedName("queue") val queue: List<QueueItem>?,
    @SerializedName("lastSync") val lastSync: LastSync?
)

data class QueueItem(
    @SerializedName("table") val table: String?,
    @SerializedName("pending") val pending: Int?
)

data class LastSync(
    @SerializedName("at") val at: String?,
    @SerializedName("status") val status: String?,
    @SerializedName("newCount") val newCount: Int?
)

data class ProjectInfo(
    @SerializedName("currentSha") val currentSha: String?,
    @SerializedName("currentRef") val currentRef: String?,
    @SerializedName("upstreamSha") val upstreamSha: String?,
    @SerializedName("upstreamBranch") val upstreamBranch: String?,
    @SerializedName("aheadBy") val aheadBy: Int?,
    @SerializedName("pendingMigrations") val pendingMigrations: List<String>?,
    @SerializedName("updateStatus") val updateStatus: String?,
    @SerializedName("updater") val updater: Updater?
)

data class Updater(
    @SerializedName("connected") val connected: Boolean?,
    @SerializedName("active") val active: Boolean?,
    @SerializedName("state") val state: String?
)

// Auth
data class AuthResponse(
    @SerializedName("success") val success: Boolean,
    @SerializedName("access_token") val accessToken: String?,
    @SerializedName("refresh_token") val refreshToken: String?,
    @SerializedName("user") val user: AuthUser?,
    @SerializedName("error") val error: String?
)

data class AuthUser(
    @SerializedName("id") val id: String?,
    @SerializedName("email") val email: String?,
    @SerializedName("cmdr_name") val cmdrName: String?,
    @SerializedName("role") val role: String?
)

data class LoginRequest(
    @SerializedName("email") val email: String,
    @SerializedName("password") val password: String
)
