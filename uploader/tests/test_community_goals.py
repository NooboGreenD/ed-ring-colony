import unittest

from community_goals import CommunityGoalReportCollector, community_goal_reports_from_event


class CommunityGoalReportTests(unittest.TestCase):
    def setUp(self):
        self.event = {
            "event": "CommunityGoal",
            "timestamp": "2026-10-22T18:34:00Z",
            "CurrentGoals": [{
                "CGID": 428,
                "Title": "Operation Andronicus",
                "SystemName": "Pleiades Sector IR-W d1-55",
                "MarketName": "The Oracle",
                "Expiry": "2026-10-29T16:00:00Z",
                "IsComplete": False,
                "CurrentTotal": 2838230000,
                "PlayerContribution": 123456,
                "NumContributors": 408,
                "TierReached": "Tier 4",
                "PlayerPercentileBand": 75,
                "PlayerInTopRank": False,
            }],
        }

    def test_extracts_account_report_fields(self):
        [row] = community_goal_reports_from_event(self.event)
        self.assertEqual(row["game_cg_id"], 428)
        self.assertEqual(row["title"], "Operation Andronicus")
        self.assertEqual(row["player_contribution"], 123456)
        self.assertEqual(row["current_total"], 2838230000)
        self.assertEqual(row["tier_reached"], 4)
        self.assertEqual(row["contributors_num"], 408)
        self.assertEqual(row["observed_at"], "2026-10-22T18:34:00Z")

    def test_invalid_and_unrelated_events_are_ignored(self):
        self.assertEqual(community_goal_reports_from_event({"event": "Docked"}), [])
        self.assertEqual(community_goal_reports_from_event({
            **self.event,
            "CurrentGoals": [{"Title": "Missing id"}, None],
        }), [])

    def test_collector_deduplicates_and_requeues_failed_uploads(self):
        collector = CommunityGoalReportCollector()
        self.assertTrue(collector.feed("", self.event))
        self.assertFalse(collector.feed("", self.event))
        [row] = collector.drain()
        collector.requeue([row])
        self.assertEqual(collector.drain(), [row])
        self.assertEqual(collector.drain(), [])


if __name__ == "__main__":
    unittest.main()
