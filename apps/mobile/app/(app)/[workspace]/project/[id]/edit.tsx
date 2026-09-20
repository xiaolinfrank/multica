/**
 * Edit project title / description / icon / collaboration space. Modal
 * presentation, configured in `[workspace]/_layout.tsx`. Save button in the
 * header runs an optimistic `useUpdateProject`; the modal dismisses on
 * success.
 *
 * Cancel/dismiss flow: header Cancel + iOS drag-down gesture both check
 * dirty state and pop an Alert if there are unsaved edits.
 *
 * The collaboration-space path is validated by the server (absolute path,
 * <= 1024 UTF-8 bytes, no control characters); an invalid one comes back as
 * a 400 and lands in the existing save-failure Alert. The client only trims
 * and maps empty to null — the same "key present with null clears it"
 * contract the other fields already use.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { Text } from "@/components/ui/text";
import { AutosizeTextArea } from "@/components/ui/autosize-textarea";
import {
  MIN_BODY_INPUT_HEIGHT_PX,
  MOBILE_PLACEHOLDER_COLOR,
} from "@/components/ui/input-tokens";
import { ApiError } from "@/data/api";
import { projectDetailOptions } from "@/data/queries/projects";
import { useUpdateProject } from "@/data/mutations/projects";
import { useWorkspaceStore } from "@/data/workspace-store";

export default function EditProject() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const wsId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const detail = useQuery(projectDetailOptions(wsId, id));
  const update = useUpdateProject(id);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [icon, setIcon] = useState("");
  const [collabPath, setCollabPath] = useState("");
  const [seeded, setSeeded] = useState(false);

  // Seed local state once detail lands. Effect (not setState-in-render)
  // so we don't accidentally retrigger on every parent re-render — the
  // `seeded` guard makes it idempotent.
  useEffect(() => {
    if (!detail.data || seeded) return;
    setTitle(detail.data.title);
    setDescription(detail.data.description ?? "");
    setIcon(detail.data.icon ?? "");
    setCollabPath(detail.data.collab_path ?? "");
    setSeeded(true);
  }, [detail.data, seeded]);

  const dirty = useMemo(() => {
    if (!detail.data) return false;
    return (
      title.trim() !== detail.data.title ||
      description.trim() !== (detail.data.description ?? "") ||
      icon.trim() !== (detail.data.icon ?? "") ||
      collabPath.trim() !== (detail.data.collab_path ?? "")
    );
  }, [detail.data, title, description, icon, collabPath]);

  const canSave =
    seeded && title.trim().length > 0 && dirty && !update.isPending;

  const onCancel = useCallback(() => {
    if (!dirty) {
      router.back();
      return;
    }
    Alert.alert(
      "Discard changes?",
      "Your edits to this project will be lost.",
      [
        { text: "Keep editing", style: "cancel" },
        {
          text: "Discard",
          style: "destructive",
          onPress: () => router.back(),
        },
      ],
    );
  }, [dirty]);

  const onSave = useCallback(() => {
    if (!canSave) return;
    const patch = {
      title: title.trim(),
      description: description.trim() || null,
      icon: icon.trim() || null,
      collab_path: collabPath.trim() || null,
    };
    update.mutate(patch, {
      onSuccess: () => router.back(),
      onError: (err) => {
        Alert.alert("Failed to save", saveErrorMessage(err));
      },
    });
  }, [canSave, title, description, icon, collabPath, update]);

  const headerLeft = useCallback(() => {
    return (
      <Pressable onPress={onCancel} className="px-1 py-1">
        <Text className="text-base text-brand">Cancel</Text>
      </Pressable>
    );
  }, [onCancel]);

  const headerRight = useCallback(() => {
    return (
      <Pressable
        onPress={onSave}
        disabled={!canSave}
        className={canSave ? "px-1 py-1" : "px-1 py-1 opacity-40"}
      >
        <Text className="text-base text-brand font-semibold">
          {update.isPending ? "Saving…" : "Save"}
        </Text>
      </Pressable>
    );
  }, [canSave, onSave, update.isPending]);

  return (
    <>
      <Stack.Screen options={{ headerLeft, headerRight }} />
      <KeyboardAvoidingView
        className="flex-1 bg-background"
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          className="flex-1"
          contentContainerClassName="px-4 pt-4 pb-6 gap-4"
          keyboardShouldPersistTaps="handled"
        >
          {!detail.data ? (
            <Text className="text-sm text-muted-foreground">Loading…</Text>
          ) : (
            <>
              <Field label="Icon (emoji)">
                <TextInput
                  value={icon}
                  onChangeText={(v) => {
                    // Cap at two characters — emoji are usually 1-2 UTF-16
                    // code units. Prevents the user typing a full sentence
                    // by accident.
                    setIcon(v.slice(0, 4));
                  }}
                  placeholder="📦"
                  placeholderTextColor={MOBILE_PLACEHOLDER_COLOR}
                  className="text-2xl text-foreground bg-secondary/50 rounded-md px-3 py-2 self-start min-w-[60px] text-center"
                  maxLength={4}
                />
              </Field>

              <Field label="Title">
                <TextInput
                  value={title}
                  onChangeText={setTitle}
                  placeholder="Project title"
                  placeholderTextColor={MOBILE_PLACEHOLDER_COLOR}
                  className="text-base text-foreground bg-secondary/50 rounded-md px-3 py-2"
                  autoFocus={!detail.data?.title}
                  returnKeyType="next"
                />
              </Field>

              <Field label="Description">
                <AutosizeTextArea
                  value={description}
                  onChangeText={setDescription}
                  placeholder="What is this project about?"
                  className="bg-secondary/50 rounded-md px-3 py-2"
                  minHeight={MIN_BODY_INPUT_HEIGHT_PX}
                />
              </Field>

              <Field label="Collaboration space">
                {/* Single line on purpose: a newline is a control character
                    the server rejects, and paths are pasted far more often
                    than typed. maxLength is a coarse stop for a runaway
                    paste, not the rule — the server bounds 1024 UTF-8 BYTES,
                    which a CJK path reaches in far fewer characters, and it
                    stays the authority on what a valid path is. */}
                <TextInput
                  value={collabPath}
                  onChangeText={setCollabPath}
                  placeholder="/Volumes/share/folder"
                  placeholderTextColor={MOBILE_PLACEHOLDER_COLOR}
                  className="text-base text-foreground bg-secondary/50 rounded-md px-3 py-2"
                  autoCapitalize="none"
                  autoCorrect={false}
                  spellCheck={false}
                  maxLength={1024}
                  returnKeyType="done"
                />
              </Field>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </>
  );
}

/**
 * Server sentence for a rejected save, falling back to the transport message.
 *
 * ApiError.message is built from `body.message`, but this API writes its
 * failures as `{"error": "..."}` (writeError in server/internal/handler),
 * so a rejected field would otherwise reach the user as "400 Bad Request".
 * The collab_path rejections are the ones worth reading — "must be an
 * absolute path", "must not contain control characters" — and they name the
 * fix. Local to this screen on purpose: the same gap exists app-wide and
 * deserves its own change in `data/api.ts`, not a silent widening here.
 */
function saveErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.body && typeof err.body === "object") {
    const serverError = (err.body as { error?: unknown }).error;
    if (typeof serverError === "string" && serverError.trim() !== "") {
      return serverError;
    }
  }
  return err instanceof Error ? err.message : "Unknown error";
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <View className="gap-1.5">
      <Text className="text-xs uppercase tracking-wider text-muted-foreground">
        {label}
      </Text>
      {children}
    </View>
  );
}

