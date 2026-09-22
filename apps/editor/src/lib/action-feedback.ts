export interface ActionFeedback {
  status: "idle" | "pending" | "success" | "error";
  message?: string;
}

export type ActionResult = void | boolean;
