import type { MatchStatus } from "../types";

const labelByStatus: Record<MatchStatus, string> = {
  missing: "未成功匹配",
  partial: "部分匹配",
  matched: "已匹配"
};

export const StatusBadge = ({ status }: { status: MatchStatus }) => {
  return <span className={`status-badge ${status}`}>{labelByStatus[status]}</span>;
};
