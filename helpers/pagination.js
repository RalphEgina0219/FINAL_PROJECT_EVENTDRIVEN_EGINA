// Builds pagination data for the pagination partial, keeping the current filters in each link.
export const buildPagination = ({ total, page, perPage, basePath, query = {} }) => {
  const pages = Math.max(1, Math.ceil(total / perPage));
  const current = Math.min(Math.max(1, page), pages);

  const href = (n) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (key !== "page" && value !== undefined && value !== null && value !== "") params.set(key, value);
    }
    if (n > 1) params.set("page", n);
    const qs = params.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  };

  const start = Math.max(1, current - 2);
  const end = Math.min(pages, start + 4);
  const links = [];
  for (let n = Math.max(1, end - 4); n <= end; n++) links.push({ n, href: href(n), active: n === current });

  return {
    total,
    page: current,
    pages,
    from: total ? (current - 1) * perPage + 1 : 0,
    to: Math.min(total, current * perPage),
    offset: (current - 1) * perPage,
    limit: perPage,
    prevHref: current > 1 ? href(current - 1) : null,
    nextHref: current < pages ? href(current + 1) : null,
    links,
    show: pages > 1,
  };
};
