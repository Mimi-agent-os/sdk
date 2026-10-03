/** @mimi-os/sdk/testing — the fakes a gateway (or an agent) is tested against. */

export { RefusedError, type RefusalKind } from "../client.ts";
export { gatewayHeaders } from "../runtime/app-executor.ts";
export {
    createFakeAgentCore,
    fakeAgentSocket,
    fakeIdentity,
    type AgentIdentity,
    type AgentSocketLike,
    type FakeAgentCore,
    type FakeAgentOptions,
    type MisbehaviorMode,
    type RawSocketLike,
    type ToolHandler,
    type ToolResult,
    type ToolTable,
} from "./fake-agent.ts";
export {
    createFakeModel,
    type FakeModel,
    type FinishDelta,
    type ScriptedTurn,
    type TextDelta,
    type ToolCallDelta,
    type TurnEvent,
    type TurnUsage,
} from "./fake-model.ts";
export { HandshakeSocket, type HandshakeSocketOptions, type SentFrame } from "./handshake-socket.ts";
