import { AgentWorkspace } from "@/features/chat/agent-workspace";
import { LiveActivityProvider } from "@/components/interior/live-activity";

function App() {
  return (
    <LiveActivityProvider>
      <AgentWorkspace />
    </LiveActivityProvider>
  );
}

export default App;
