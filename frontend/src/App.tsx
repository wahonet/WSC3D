import { AppProviders } from "./app/AppProviders";
import { AppShell } from "./app/AppShell";

export function App() {
  return (
    <AppProviders>
      <AppShell />
    </AppProviders>
  );
}
