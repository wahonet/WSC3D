import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import type { TaskProgress } from "../../modules/annotation/TaskProgressPanel";

type TasksContextValue = {
  tasks: TaskProgress[];
  upsertTask: (task: TaskProgress) => void;
  requestCancelTask: (id: string) => void;
  dismissTask: (id: string) => void;
  cancelRequestedRef: React.MutableRefObject<Set<string>>;
};

const TasksContext = createContext<TasksContextValue | null>(null);

export function TasksProvider({ children }: { children: ReactNode }) {
  const [tasks, setTasks] = useState<TaskProgress[]>([]);
  const cancelRequestedRef = useRef<Set<string>>(new Set());

  const upsertTask = useCallback((task: TaskProgress) => {
    setTasks((prev) => {
      const next = prev.filter((t) => t.id !== task.id);
      next.push(task);
      return next.slice(-6);
    });
  }, []);

  const requestCancelTask = useCallback((id: string) => {
    cancelRequestedRef.current.add(id);
  }, []);

  const dismissTask = useCallback((id: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== id));
    cancelRequestedRef.current.delete(id);
  }, []);

  const value = useMemo(
    () => ({ tasks, upsertTask, requestCancelTask, dismissTask, cancelRequestedRef }),
    [tasks, upsertTask, requestCancelTask, dismissTask]
  );

  return <TasksContext.Provider value={value}>{children}</TasksContext.Provider>;
}

export function useTasks() {
  const ctx = useContext(TasksContext);
  if (!ctx) throw new Error("useTasks must be used within TasksProvider");
  return ctx;
}
