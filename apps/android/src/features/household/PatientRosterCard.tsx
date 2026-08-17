import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import type { Patient } from '@medguard/shared';
import { useClock, useIdGenerator, useRepository } from '../../app/RepositoryContext.js';
import { useLiveQuery } from '../../store/useLiveQuery.js';
import { Button, Card, colors, styles as sharedStyles } from '../../ui/primitives.js';

/**
 * Add, rename, reorder, and archive the patients this household tracks medicine for — the RN
 * port of `apps/web/src/features/household/PatientRosterCard.tsx`.
 *
 * Archive only, never delete: medicines, schedules, and intake logs reference a patient forever
 * (safety invariant 1), and an export or a safety banner still needs to be able to name them —
 * the same reason `archiveMedicine` exists instead of a delete.
 */
export function PatientRosterCard(): React.JSX.Element {
  const repository = useRepository();
  const ids = useIdGenerator();
  const clock = useClock();

  const [newName, setNewName] = useState('');
  const [adding, setAdding] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const all = useLiveQuery(() => repository.allPatients(), ['patients']);
  const active = (all ?? [])
    .filter((patient) => !patient.archived)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const archived = (all ?? []).filter((patient) => patient.archived);

  const handleAdd = async () => {
    const displayName = newName.trim();
    if (!displayName) return;

    setAdding(true);
    try {
      const nextSortOrder =
        active.length === 0 ? 0 : Math.max(...active.map((patient) => patient.sortOrder)) + 1;
      await repository.savePatient(
        {
          id: ids.next(),
          displayName,
          archived: false,
          sortOrder: nextSortOrder,
          updatedAt: clock.nowIso(),
          updatedByDeviceId: '',
          syncStatus: 'pending',
        },
        'CREATE',
      );
      setNewName('');
    } finally {
      setAdding(false);
    }
  };

  const startRename = (patient: Patient) => {
    setRenamingId(patient.id);
    setRenameValue(patient.displayName);
  };

  const commitRename = async (patient: Patient) => {
    const displayName = renameValue.trim();
    setRenamingId(null);
    if (!displayName || displayName === patient.displayName) return;
    await repository.savePatient({ ...patient, displayName });
  };

  const handleArchive = async (patient: Patient) => {
    await repository.archivePatient(patient.id);
  };

  const handleRestore = async (patient: Patient) => {
    await repository.savePatient({ ...patient, archived: false });
  };

  const move = async (patient: Patient, direction: -1 | 1) => {
    const index = active.findIndex((candidate) => candidate.id === patient.id);
    const neighbor = active[index + direction];
    if (!neighbor) return;

    // Swap sortOrder values rather than renumbering the whole list — two writes, unaffected by
    // how many other patients exist.
    await repository.savePatient({ ...patient, sortOrder: neighbor.sortOrder });
    await repository.savePatient({ ...neighbor, sortOrder: patient.sortOrder });
  };

  return (
    <Card>
      <Text style={sharedStyles.title}>Patients</Text>
      <Text style={sharedStyles.subtitle}>
        Everyone in this household whose medicines are tracked. A medicine can belong to one patient
        or be shared across several.
      </Text>

      <View style={{ gap: 8 }}>
        {active.map((patient, index) => (
          <View key={patient.id} style={rowStyle}>
            {renamingId === patient.id ? (
              <View style={[sharedStyles.row, { flex: 1 }]}>
                <TextInput
                  style={[sharedStyles.input, { flex: 1 }]}
                  value={renameValue}
                  autoFocus
                  onChangeText={setRenameValue}
                  onBlur={() => void commitRename(patient)}
                  accessibilityLabel={`Rename ${patient.displayName}`}
                />
                <Button label="Save" onPress={() => void commitRename(patient)} />
              </View>
            ) : (
              <Pressable
                accessibilityRole="button"
                style={{ flex: 1 }}
                onPress={() => startRename(patient)}
              >
                <Text style={{ color: colors.text, fontWeight: '600' }}>{patient.displayName}</Text>
              </Pressable>
            )}
            <View style={sharedStyles.row}>
              <Button label="↑" onPress={() => void move(patient, -1)} disabled={index === 0} />
              <Button
                label="↓"
                onPress={() => void move(patient, 1)}
                disabled={index === active.length - 1}
              />
              <Button label="Archive" onPress={() => void handleArchive(patient)} />
            </View>
          </View>
        ))}
        {active.length === 0 && <Text style={sharedStyles.subtitle}>No patients yet.</Text>}
      </View>

      <View style={sharedStyles.row}>
        <TextInput
          style={[sharedStyles.input, { flex: 1 }]}
          placeholder="Patient name"
          placeholderTextColor={colors.textMuted}
          value={newName}
          onChangeText={setNewName}
          accessibilityLabel="New patient name"
        />
        <Button
          label="Add"
          variant="primary"
          onPress={() => void handleAdd()}
          disabled={adding || !newName.trim()}
        />
      </View>

      {archived.length > 0 && (
        <View style={{ gap: 8, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 12 }}>
          <Button
            label={`${showArchived ? 'Hide' : 'Show'} archived (${archived.length})`}
            onPress={() => setShowArchived((current) => !current)}
          />
          {showArchived && (
            <View style={{ gap: 8 }}>
              {archived.map((patient) => (
                <View key={patient.id} style={[rowStyle, { opacity: 0.7 }]}>
                  <Text style={{ color: colors.textMuted, flex: 1 }}>{patient.displayName}</Text>
                  <Button label="Restore" onPress={() => void handleRestore(patient)} />
                </View>
              ))}
            </View>
          )}
        </View>
      )}
    </Card>
  );
}

const rowStyle = {
  flexDirection: 'row',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  borderWidth: 1,
  borderColor: colors.border,
  borderRadius: 8,
  padding: 10,
} as const;
