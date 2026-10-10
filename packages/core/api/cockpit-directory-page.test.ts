// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";
const entry = { party: "Research", name: "Pat", position: "Lead", source: "user" };
const page = { workspace_id: "ws", scope: "workspace", q: "", party: null, parties: null, items: [entry], total: 1, next_cursor: null };
const receipt = { workspace_id: "ws", scope: "workspace", action: "upserted", entries: [entry], skipped: [], deleted: [] };
function reply(body: unknown) {
 const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), {status: 200,headers:{"Content-Type":"application/json"}}));
 vi.stubGlobal("fetch", fetchMock);return {client:new ApiClient("https://example.test"), fetchMock};
}
afterEach(()=>vi.unstubAllGlobals());
describe("workspace contact directory contracts",()=>{
 it("sends explicit workspace and preserves an empty unfiled party",async()=>{
  const {client,fetchMock}=reply({...page,party:"",items:[{...entry,party:""}]});
  await expect(client.getCockpitDirectoryPage("ws",{party:""})).resolves.not.toBeNull();
  const url=new URL(String(fetchMock.mock.calls[0]![0]));expect(url.searchParams.has("party")).toBe(true);expect(url.searchParams.get("party")).toBe("");
  expect(fetchMock.mock.calls[0]![1].headers).toMatchObject({"X-Workspace-ID":"ws"});
 });
 it("normalizes and echoes multi-party OR without replacing it with a single unit",async()=>{
  const {client,fetchMock}=reply({...page,parties:["Clinical","Research"],q:"Pat"});
  await expect(client.getCockpitDirectoryPage("ws",{parties:["Research"," Clinical ","Research"],q:" Pat "})).resolves.not.toBeNull();
  expect(new URL(String(fetchMock.mock.calls[0]![0])).searchParams.getAll("parties")).toEqual(["Clinical","Research"]);
  await expect(reply(page).client.getCockpitDirectoryPage("ws",{parties:["Research"]})).resolves.toBeNull();
 });
 it("rejects wrong workspace, incomplete metadata, duplicate natural keys and oversized pages",async()=>{
  for(const bad of [{...page,workspace_id:"other"},{...page,scope:"project"},{...page,total:undefined},{...page,items:[entry,entry]},{...page,items:Array.from({length:26},(_,i)=>({...entry,name:`P${i}`})),total:26},{...page,next_cursor:"next"}]) {
   await expect(reply(bad).client.getCockpitDirectoryPage("ws")).resolves.toBeNull();
  }
  await expect(reply({...page,items:[{...entry,source:"future"}]}).client.getCockpitDirectoryPage("ws")).resolves.toMatchObject({items:[{source:"future"}]});
 });
 it("accepts only final deduplicated saved rows and fails closed on legacy whole-book replies",async()=>{
  const body={entries:[{...entry,position:"First"},{...entry,position:"Lead"},{...entry,position:""}]};
  await expect(reply(receipt).client.upsertCockpitDirectoryCompact("ws",body)).resolves.toEqual(receipt);
  for(const bad of [{entries:[entry]},{...receipt,workspace_id:"other"},{...receipt,entries:[{...entry,position:"First"}]},{...receipt,entries:[entry,entry]}]) {
   await expect(reply(bad).client.upsertCockpitDirectoryCompact("ws",body)).rejects.toThrow("cockpit_write_not_confirmed");
  }
 });
 it("requires explicit position clearing to be acknowledged while name-only saves preserve known positions",async()=>{
  await expect(reply(receipt).client.upsertCockpitDirectoryCompact("ws",{entries:[{party:entry.party,name:entry.name,position:""}]})).resolves.not.toBeNull();
  await expect(reply(receipt).client.upsertCockpitDirectoryCompact("ws",{entries:[{...entry,position:"",clear_position:true}]})).rejects.toThrow();
  await expect(reply({...receipt,entries:[{...entry,position:""}]}).client.upsertCockpitDirectoryCompact("ws",{entries:[{...entry,position:"",clear_position:true}]})).resolves.not.toBeNull();
 });
 it("recognizes skipped auto-file names without pretending they were saved",async()=>{
  const skipped={...receipt,entries:[],skipped:[{party:entry.party,name:entry.name}]};
  await expect(reply(skipped).client.upsertCockpitDirectoryCompact("ws",{entries:[entry],only_unknown_names:true})).resolves.toEqual(skipped);
  await expect(reply(skipped).client.upsertCockpitDirectoryCompact("ws",{entries:[entry]})).rejects.toThrow();
  await expect(reply({...skipped,skipped:[]}).client.upsertCockpitDirectoryCompact("ws",{entries:[entry],only_unknown_names:true})).rejects.toThrow();
 });
 it("requires the exact deleted natural key and does not accept extra removals",async()=>{
  const deleted={...receipt,action:"deleted",entries:[],deleted:[{party:entry.party,name:entry.name}]};
  const {client,fetchMock}=reply(deleted);await expect(client.deleteCockpitDirectoryCompact("ws",entry)).resolves.toEqual(deleted);
  expect(fetchMock.mock.calls[0]![1].headers).toMatchObject({"X-Workspace-ID":"ws"});
  await expect(reply({...deleted,deleted:[{party:"Other",name:entry.name}]}).client.deleteCockpitDirectoryCompact("ws",entry)).rejects.toThrow();
 });
});
