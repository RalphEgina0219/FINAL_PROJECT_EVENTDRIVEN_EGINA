// Team Performance (CRM Manager: every team) and Agent Assignments (Team Leader: own team).
import { agentWorkload, teamSummary } from "../services/dashboardService.js";

export const performance = async (req, res) => {
  const isManager = req.user.role === "crm_manager";
  const [workload, teams] = await Promise.all([agentWorkload(req.user), isManager ? teamSummary() : Promise.resolve([])]);
  res.render("team/performance", {
    title: isManager ? "Team Performance" : "Agent Assignments",
    workload, teams, isManager, teamName: req.user.team_name,
  });
};
