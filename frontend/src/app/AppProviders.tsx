import type { ReactNode } from "react";
import { AssemblyPlansProvider } from "./contexts/AssemblyPlansContext";
import { AnnotationStatusProvider } from "./contexts/AnnotationStatusContext";
import { StoneSelectionProvider } from "./contexts/StoneSelectionContext";
import { TasksProvider } from "./contexts/TasksContext";
import { ViewportProvider } from "./contexts/ViewportContext";
import { WorkspaceModeProvider } from "./contexts/WorkspaceModeContext";

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <StoneSelectionProvider>
      <WorkspaceModeProvider>
        <ViewportProvider>
          <AssemblyPlansProvider>
            <AnnotationStatusProvider>
              <TasksProvider>{children}</TasksProvider>
            </AnnotationStatusProvider>
          </AssemblyPlansProvider>
        </ViewportProvider>
      </WorkspaceModeProvider>
    </StoneSelectionProvider>
  );
}
