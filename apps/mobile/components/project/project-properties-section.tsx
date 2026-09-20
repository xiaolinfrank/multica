/**
 * Project properties section. Tappable rows for Status / Priority / Lead.
 * Each row opens a picker sheet via the corresponding `onPress*` callback.
 *
 * Layout mirrors iOS Settings rows: label on left, current value on right
 * with a disclosure chevron, full-width separator below each row. Tapping
 * anywhere on the row triggers the picker.
 *
 * Lead supports both member and agent (Project.lead_type), resolved via
 * useActorLookup so it shares the same lookup with my-issues + issue detail.
 *
 * The collaboration-space row is the one exception to the row geometry: the
 * value is a filesystem path that routinely runs past the width of a phone,
 * so it stacks under its label and wraps instead of truncating next to it.
 * It is read-only here (editing lives on the edit screen) and is hidden when
 * the project has no path, so an unused attribute costs no vertical space.
 */
import { useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import type { Project } from "@multica/core/types";
import { Text } from "@/components/ui/text";
import { ActorAvatar } from "@/components/ui/actor-avatar";
import { ProjectStatusIcon } from "@/components/ui/project-status-icon";
import { ProjectPriorityIcon } from "@/components/ui/project-priority-icon";
import {
  projectPriorityLabel,
  projectStatusLabel,
} from "@/lib/project-status";
import { useActorLookup } from "@/data/use-actor-name";
import { useColorScheme } from "@/lib/use-color-scheme";
import { THEME } from "@/lib/theme";

interface Props {
  project: Project;
  onPressStatus: () => void;
  onPressPriority: () => void;
  onPressLead: () => void;
}

export function ProjectPropertiesSection({
  project,
  onPressStatus,
  onPressPriority,
  onPressLead,
}: Props) {
  const { getName } = useActorLookup();
  const leadName =
    project.lead_type && project.lead_id
      ? getName(project.lead_type, project.lead_id)
      : null;
  // Trimmed because the server stores what it was given after its own trim;
  // a whitespace-only value would otherwise render an empty row.
  const collabPath = project.collab_path?.trim() || null;

  return (
    <View className="border-y border-border bg-background">
      <Row
        label="Status"
        onPress={onPressStatus}
        left={<ProjectStatusIcon status={project.status} size={16} />}
        right={
          <Text className="text-sm text-foreground">
            {projectStatusLabel(project.status)}
          </Text>
        }
      />
      <Separator />
      <Row
        label="Priority"
        onPress={onPressPriority}
        left={<ProjectPriorityIcon priority={project.priority} size={16} />}
        right={
          <Text className="text-sm text-foreground">
            {projectPriorityLabel(project.priority)}
          </Text>
        }
      />
      <Separator />
      <Row
        label="Lead"
        onPress={onPressLead}
        left={
          leadName ? (
            <ActorAvatar
              type={project.lead_type}
              id={project.lead_id}
              size={20}
              showPresence
            />
          ) : (
            <PlaceholderAvatar />
          )
        }
        right={
          <Text
            className={
              leadName
                ? "text-sm text-foreground"
                : "text-sm text-muted-foreground"
            }
          >
            {leadName ?? "Unassigned"}
          </Text>
        }
      />
      {collabPath ? (
        <>
          <Separator />
          <CollabPathRow path={collabPath} />
        </>
      ) : null}
    </View>
  );
}

/**
 * Read-only collaboration-space path. Tapping copies it — on a phone the
 * only useful thing to do with a NAS path is paste it somewhere else, and
 * the path is too long to retype. Copy feedback mirrors the markdown code
 * block (light haptic + a 2s checkmark), which is the app's existing
 * copy affordance.
 */
function CollabPathRow({ path }: { path: string }) {
  const { colorScheme } = useColorScheme();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cancel the pending reset on unmount so the timer can't setState on a
  // dead component when the user navigates away right after copying.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const onCopy = async () => {
    try {
      await Clipboard.setStringAsync(path);
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard write failed (extremely rare on iOS). Silent — there is no
      // recovery path, same call as lib/markdown/code-block.tsx.
    }
  };

  return (
    <Pressable
      onPress={onCopy}
      className="px-4 py-3 gap-1 active:bg-secondary"
      accessibilityRole="button"
      accessibilityLabel={
        copied
          ? "Collaboration space path copied"
          : `Collaboration space, ${path}. Copy path`
      }
    >
      <Text className="text-sm text-muted-foreground">Collaboration space</Text>
      <View className="flex-row items-start gap-2">
        <Ionicons
          name="folder-outline"
          size={16}
          color={THEME[colorScheme].mutedForeground}
          style={{ marginTop: 2 }}
        />
        <Text className="text-sm text-foreground flex-1">{path}</Text>
        <Ionicons
          name={copied ? "checkmark" : "copy-outline"}
          size={14}
          color={
            copied
              ? THEME[colorScheme].success
              : THEME[colorScheme].mutedForeground
          }
          style={{ marginTop: 3 }}
        />
      </View>
    </Pressable>
  );
}

function Row({
  label,
  onPress,
  left,
  right,
}: {
  label: string;
  onPress: () => void;
  left: React.ReactNode;
  right: React.ReactNode;
}) {
  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center gap-3 px-4 py-3 active:bg-secondary"
    >
      <Text className="text-sm text-muted-foreground w-20">{label}</Text>
      <View className="flex-row items-center gap-2 flex-1">
        {left}
        {right}
      </View>
      <Chevron />
    </Pressable>
  );
}

function Separator() {
  return <View className="h-px bg-border ml-4" />;
}

function Chevron() {
  const { colorScheme } = useColorScheme();
  return (
    <Ionicons
      name="chevron-forward"
      size={14}
      color={THEME[colorScheme].mutedForeground}
    />
  );
}

function PlaceholderAvatar() {
  return (
    <View
      style={{ width: 20, height: 20, borderRadius: 10 }}
      className="border border-dashed border-muted-foreground/40"
    />
  );
}
