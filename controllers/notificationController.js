// Notifications page: list, open (marks read), mark all read.
import { listNotifications, markRead, markAllRead } from "../services/notificationService.js";
import { buildPagination } from "../helpers/pagination.js";
import { toId, toPage } from "../helpers/validators.js";

export const index = async (req, res) => {
  const page = toPage(req.query.page);
  const first = await listNotifications(req.user.id, { limit: 1, offset: 0 });
  const pagination = buildPagination({ total: first.total, page, perPage: 15, basePath: "/notifications" });
  const { rows } = await listNotifications(req.user.id, { limit: pagination.limit, offset: pagination.offset });
  res.render("notifications/index", { title: "Notifications", rows, pagination });
};

export const open = async (req, res) => {
  const id = toId(req.params.id);
  const link = id ? await markRead(req.user.id, id) : null;
  // Only follow internal links.
  res.redirect(link && link.startsWith("/") && !link.startsWith("//") ? link : "/notifications");
};

export const readAll = async (req, res) => {
  await markAllRead(req.user.id);
  req.flash("success_msg", "All notifications marked as read.");
  res.redirect("/notifications");
};
