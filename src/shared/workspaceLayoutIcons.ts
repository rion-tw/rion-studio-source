import type { WorkspaceLayoutTemplate } from "./types";

export type WorkspaceLayoutIconNode = [
  elementName: "path" | "rect",
  attributes: Record<string, string>
];

const columns2: WorkspaceLayoutIconNode[] = [
  ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2", key: "outer" }],
  ["path", { d: "M12 3v18", key: "column" }]
];

const columns3: WorkspaceLayoutIconNode[] = [
  ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2", key: "outer" }],
  ["path", { d: "M9 3v18", key: "left-column" }],
  ["path", { d: "M15 3v18", key: "right-column" }]
];

const columns4: WorkspaceLayoutIconNode[] = [
  ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2", key: "outer" }],
  ["path", { d: "M7.5 3v18", key: "column-1" }],
  ["path", { d: "M12 3v18", key: "column-2" }],
  ["path", { d: "M16.5 3v18", key: "column-3" }]
];

export const workspaceLayoutIconNodes: Record<
  WorkspaceLayoutTemplate,
  WorkspaceLayoutIconNode[]
> = {
  single: columns2,
  two_columns: columns2,
  three_columns: columns3,
  main_left_stack_right: [
    ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2", key: "outer" }],
    ["path", { d: "M9 3v18", key: "column" }],
    ["path", { d: "M9 15h12", key: "row" }]
  ],
  main_right_stack_left: [
    ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2", key: "outer" }],
    ["path", { d: "M3 15h12", key: "row" }],
    ["path", { d: "M15 3v18", key: "column" }]
  ],
  main_center_side_stacks: [
    ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2", key: "outer" }],
    ["path", { d: "M8 3v18", key: "left-column" }],
    ["path", { d: "M16 3v18", key: "right-column" }],
    ["path", { d: "M3 12h5", key: "left-row" }],
    ["path", { d: "M16 12h5", key: "right-row" }]
  ],
  three_top_two_bottom: [
    ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2", key: "outer" }],
    ["path", { d: "M3 12h18", key: "row" }],
    ["path", { d: "M9 3v9", key: "top-column-1" }],
    ["path", { d: "M15 3v9", key: "top-column-2" }],
    ["path", { d: "M12 12v9", key: "bottom-column" }]
  ],
  two_top_three_bottom: [
    ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2", key: "outer" }],
    ["path", { d: "M3 12h18", key: "row" }],
    ["path", { d: "M12 3v9", key: "top-column" }],
    ["path", { d: "M9 12v9", key: "bottom-column-1" }],
    ["path", { d: "M15 12v9", key: "bottom-column-2" }]
  ],
  quad: [
    ["path", { d: "M12 3v18", key: "column" }],
    ["path", { d: "M3 12h18", key: "row" }],
    ["rect", { x: "3", y: "3", width: "18", height: "18", rx: "2", key: "outer" }]
  ],
  four_columns: columns4,
  six_grid: [
    ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2", key: "outer" }],
    ["path", { d: "M9 3v18", key: "left-column" }],
    ["path", { d: "M15 3v18", key: "right-column" }],
    ["path", { d: "M3 12h18", key: "row" }]
  ],
  eight_grid: [
    ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2", key: "outer" }],
    ["path", { d: "M7.5 3v18", key: "column-1" }],
    ["path", { d: "M12 3v18", key: "column-2" }],
    ["path", { d: "M16.5 3v18", key: "column-3" }],
    ["path", { d: "M3 12h18", key: "row" }]
  ]
};
