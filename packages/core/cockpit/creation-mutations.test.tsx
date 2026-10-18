// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { CockpitBoardSchema, CockpitNodeSchema, CockpitMeetingSchema } from "../api/schemas";
import type { CockpitBoard } from "../types";
import { cockpitKeys } from "./queries";
import { useCreateCockpitNode, useCreateCockpitMeeting } from "./mutations";
vi.mock("../api", () => ({ api: { createCockpitNode: vi.fn(), createCockpitMeeting: vi.fn() } }));
beforeEach(() => vi.clearAllMocks()); afterEach(cleanup);
function setup(){
 const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
 const node=CockpitNodeSchema.parse({id:"node",cockpit_id:"board",code:"L1-01",name:"Live edited node"});
 const meeting=CockpitMeetingSchema.parse({id:"meeting",cockpit_id:"board",title:"Live edited meeting"});
 client.setQueryData(cockpitKeys.board("ws-1"),CockpitBoardSchema.parse({cockpit:{id:"board"},nodes:[node],meetings:[meeting]}));
 function Wrapper({children}:{children:ReactNode}){return <QueryClientProvider client={client}>{children}</QueryClientProvider>}
 return {client,node,meeting,Wrapper};
}
describe("immutable cockpit creation receipts",()=>{
 it("does not overwrite live nodes with a replayed creation snapshot",async()=>{
  const {client,node,Wrapper}=setup();const invalidate=vi.spyOn(client,"invalidateQueries");
  vi.mocked(api.createCockpitNode).mockResolvedValue({...node,name:"Original node",creation_key:"key",replayed:true});
  const hook=renderHook(()=>useCreateCockpitNode("ws-1"),{wrapper:Wrapper});
  await act(async()=>{await hook.result.current.mutateAsync({code:"L1-01",name:"Original node",creation_key:"key"})});
  expect(client.getQueryData<CockpitBoard>(cockpitKeys.board("ws-1"))?.nodes[0]?.name).toBe("Live edited node");
  expect(api.createCockpitNode).toHaveBeenCalledWith({code:"L1-01",name:"Original node",creation_key:"key"},"ws-1");
  expect(invalidate).toHaveBeenCalledWith({queryKey:cockpitKeys.board("ws-1")});
 });
 it("does not restore a removed meeting anchor or old title from a replay",async()=>{
  const {client,meeting,Wrapper}=setup();
  vi.mocked(api.createCockpitMeeting).mockResolvedValue({...meeting,title:"Original meeting",creation_key:"key",replayed:true,node_link:{meeting_id:"meeting",node_id:"old-node",position:0}});
  const hook=renderHook(()=>useCreateCockpitMeeting("ws-1"),{wrapper:Wrapper});
  await act(async()=>{await hook.result.current.mutateAsync({title:"Original meeting",node_id:"old-node",creation_key:"key"})});
  const board=client.getQueryData<CockpitBoard>(cockpitKeys.board("ws-1"));
  expect(board?.meetings[0]?.title).toBe("Live edited meeting");expect(board?.meeting_nodes).toEqual([]);
 });
});
