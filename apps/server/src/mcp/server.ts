import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  STATUSES, KanbanError, addComment, answerInput, assignTask, heartbeatTask, inbox, requestInput, claimTask, confirmTask, createTask, getTask, listBoards, createBoard, renameBoard,
  listPrincipals, listTasks, moveTask, releaseTask, updateTask, type Db, type Principal, type Status,
} from "@kanban/core";

const status = z.enum(STATUSES);
const id = z.string().uuid();

const WORKFLOW = `Workflow: proposed -> confirmed -> in_progress -> review -> done.
- You have the same rights as a human: create tasks (optionally pre-confirmed with confirmed: true), confirm tasks (including your own), assign tasks to anyone, answer questions, approve reviews, and create or rename projects.
- Pick up work with claim_task on a "confirmed" task. If you can't finish, release_task.
- Your claim is a lease (30 min by default). Any comment, update or heartbeat_task renews it; if you go quiet, another agent may take the task over.
- When finished, move_task to "review" with a summary (required) and links to evidence (PRs, files, logs).
- If you are blocked or need a decision, call request_input with a clear question; others see it in their inbox. Use inbox to see what needs your decision.
- You may not approve your own work: review -> done must be done by someone else.
- You can never approve your own work or answer your own question; someone else must.
- Use add_comment to report progress, blockers and questions.`;

export function buildMcpServer(db: Db, me: Principal): McpServer {
  const server = new McpServer({ name: "agent-kanban", version: "0.1.0" }, { instructions: WORKFLOW });

  const run = async (fn: () => Promise<unknown>) => {
    try {
      return { content: [{ type: "text" as const, text: JSON.stringify(await fn(), null, 2) }] };
    } catch (e) {
      if (e instanceof KanbanError) return { isError: true, content: [{ type: "text" as const, text: `${e.code}: ${e.message}` }] };
      throw e;
    }
  };
  const tool = (name: string, description: string, shape: z.ZodRawShape, fn: (a: any) => Promise<unknown>) =>
    server.registerTool(name, { description, inputSchema: shape }, (a: any) => run(() => fn(a)));

  tool("whoami", "Return the identity you are acting as.", {}, async () => me);
  tool("list_boards", "List projects (boards). Pass a project id as boardId to create_task / list_tasks to work within it.", {}, () => listBoards(db, me));
  tool("create_board", "Create a project (board).", { name: z.string().min(1) }, ({ name }) => createBoard(db, me, name));
  tool("rename_board", "Rename a project.", { boardId: id, name: z.string().min(1) }, ({ boardId, name }) => renameBoard(db, me, boardId, name));
  tool("list_principals", "List humans and agents (ids are needed for assign_task).", {}, () => listPrincipals(db, me));
  tool(
    "list_tasks",
    "List tasks, optionally filtered. Most important first.",
    { boardId: id.optional(), status: status.optional(), assigneeId: id.optional(), label: z.string().optional(), mine: z.boolean().optional() },
    ({ mine, ...f }) => listTasks(db, me, { ...f, assigneeId: mine ? me.id : f.assigneeId }),
  );
  tool("get_task", "Get a task with its comments and activity log.", { taskId: id }, ({ taskId }) => getTask(db, me, taskId));
  tool(
    "create_task",
    "Create a task. It starts as 'proposed' until confirmed; pass confirmed: true to create it already confirmed.",
    { title: z.string().min(1), description: z.string().optional(), priority: z.number().int().min(0).max(4).optional(), labels: z.array(z.string()).optional(), boardId: id.optional().describe("Project to create the task in; defaults to the first project"), confirmed: z.boolean().optional().describe("Create the task already confirmed") },
    (a) => createTask(db, me, a),
  );
  tool(
    "update_task",
    "Edit title, description, priority or labels. Pass expectedVersion to detect concurrent edits.",
    { taskId: id, title: z.string().optional(), description: z.string().optional(), priority: z.number().int().min(0).max(4).optional(), labels: z.array(z.string()).optional(), expectedVersion: z.number().int().optional() },
    ({ taskId, ...rest }) => updateTask(db, me, taskId, rest),
  );
  tool("confirm_task", "Confirm a proposed task so it can be worked on. You may confirm tasks you created yourself.", { taskId: id }, ({ taskId }) => confirmTask(db, me, taskId));
  tool("claim_task", "Claim a confirmed task: assigns it to you and moves it to in_progress.", { taskId: id }, ({ taskId }) => claimTask(db, me, taskId));
  tool("release_task", "Give up an in_progress task you hold; it returns to confirmed.", { taskId: id }, ({ taskId }) => releaseTask(db, me, taskId));
  tool(
    "move_task",
    "Move a task to another status (e.g. in_progress -> review, review -> done or back to in_progress).",
    { taskId: id, to: status, summary: z.string().optional().describe("Required when moving to review: what you did"), links: z.array(z.string()).optional().describe("Evidence: PR/file/log URLs") },
    ({ taskId, to, summary, links }: { taskId: string; to: Status; summary?: string; links?: string[] }) => moveTask(db, me, taskId, to, { summary, links }),
  );
  tool(
    "assign_task",
    "Assign (or unassign with null) a task. Anyone may assign to anyone; assigning an in_progress task to an agent starts a fresh lease.",
    { taskId: id, assigneeId: id.nullable() },
    ({ taskId, assigneeId }) => assignTask(db, me, taskId, assigneeId),
  );
  tool("heartbeat_task", "Renew your claim lease on an in_progress task you hold, during long-running work.", { taskId: id }, ({ taskId }) => heartbeatTask(db, me, taskId));
  tool("request_input", "Ask a question; flags the task as blocked on input. Optionally offer up to 6 short suggested answers (options) that humans can pick with one click.", { taskId: id, question: z.string().min(1), options: z.array(z.string().max(80)).max(6).optional() }, ({ taskId, question, options }) => requestInput(db, me, taskId, question, options));
  tool("answer_input", "Answer a pending question on a task (anyone except whoever asked the question).", { taskId: id, answer: z.string().min(1) }, ({ taskId, answer }) => answerInput(db, me, taskId, answer));
  tool("inbox", "Tasks waiting on your decision: to confirm, to review, with questions, or stale claims.", {}, async () => (await inbox(db, me)).map((i) => ({ kind: i.kind, id: i.task.id, title: i.task.title, status: i.task.status, question: i.task.question, reviewSummary: i.task.reviewSummary })));
  tool("add_comment", "Comment on a task.", { taskId: id, body: z.string().min(1) }, ({ taskId, body }) => addComment(db, me, taskId, body));

  server.registerPrompt("agent-workflow", { description: "How to collaborate on this board" }, () => ({
    messages: [{ role: "user", content: { type: "text", text: WORKFLOW } }],
  }));

  return server;
}
