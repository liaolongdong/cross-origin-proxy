import {
  Stack,
  Row,
  Grid,
  Divider,
  H1,
  H2,
  H3,
  Text,
  Tag,
  Stat,
  Table,
  Card,
  CardHeader,
  CardBody,
  Callout,
} from 'qoder/canvas';

export default function DeepCodeReviewReport() {
  return (
    <Stack gap={24} style={{ padding: 24 }}>
      <H1>Chrome Extension Deep Code Review</H1>
      <Text tone="secondary">web-cross-origin | MV3 Cross-Origin Proxy</Text>

      <Divider />

      <H2>Execution Summary</H2>
      <Grid columns={4} gap={16}>
        <Stat value="13" label="Tasks Completed" tone="success" />
        <Stat value="25+" label="Files Modified" />
        <Stat value="25/25" label="Tests Passing" tone="success" />
        <Stat value="0" label="Lint Warnings" tone="success" />
      </Grid>

      <Callout tone="success">
        <Text>
          All build, test, and lint checks pass. Three independent code reviews
          (completeness, correctness, impact) confirmed all requirements are met
          and critical regressions were caught and fixed.
        </Text>
      </Callout>

      <Divider />

      <H2>Security Hardening</H2>
      <Table
        headers={['Issue', 'File', 'Fix', 'Status']}
        rows={[
          ['postMessage wildcard origin', 'content.ts, main-interceptor', 'Replaced * with window.location.origin', 'Done'],
          ['ReDoS vulnerability', 'main-interceptor', 'Added isRegexSafe() nested quantifier detection', 'Done'],
          ['Error message leakage', 'content.ts', 'Sanitized to generic error message', 'Done'],
          ['Sender validation missing', 'messageRouter.ts', 'Added isTrustedSender() whitelist', 'Done'],
        ]}
      />

      <Divider />

      <H2>Data Consistency</H2>
      <Table
        headers={['Issue', 'File', 'Fix', 'Status']}
        rows={[
          ['Storage race condition', 'storage.ts', 'Promise-chain mutex for all write ops', 'Done'],
          ['Silent updateRule failure', 'storage.ts', 'Throw Error when rule not found', 'Done'],
          ['N sequential DNR rebuilds', 'storage.ts, types.ts', 'batchDeleteRules + BATCH_DELETE_RULES msg', 'Done'],
          ['ID collision risk', 'generateId.ts', 'Migrated to crypto.randomUUID()', 'Done'],
        ]}
      />

      <Divider />

      <H2>Performance Optimization</H2>
      <Grid columns={2} gap={16}>
        <Card>
          <CardHeader><H3>Hot Path Fixes</H3></CardHeader>
          <CardBody>
            <Stack gap={8}>
              <Row gap={8}><Tag tone="danger">Critical</Tag><Text>Config cache in storage.ts</Text></Row>
              <Row gap={8}><Tag tone="danger">Critical</Tag><Text>RegExp cache in urlMatcher + interceptor</Text></Row>
              <Row gap={8}><Tag tone="warning">High</Tag><Text>Log buffered writes (10 / 1s)</Text></Row>
              <Row gap={8}><Tag tone="warning">High</Tag><Text>syncQueue reset (memory leak fix)</Text></Row>
            </Stack>
          </CardBody>
        </Card>
        <Card>
          <CardHeader><H3>UI Optimizations</H3></CardHeader>
          <CardBody>
            <Stack gap={8}>
              <Row gap={8}><Tag tone="info">Medium</Tag><Text>Search input 200ms debounce</Text></Row>
              <Row gap={8}><Tag tone="info">Medium</Tag><Text>LogDrawer computed merge (3 to 1 pass)</Text></Row>
              <Row gap={8}><Tag tone="info">Low</Tag><Text>RuleTable RegExp cache</Text></Row>
              <Row gap={8}><Tag tone="info">Low</Tag><Text>Keepalive 0.5 to 1 min</Text></Row>
            </Stack>
          </CardBody>
        </Card>
      </Grid>

      <Divider />

      <H2>New Features</H2>
      <Grid columns={3} gap={16}>
        <Card>
          <CardHeader><H3>Rule Testing Tool</H3></CardHeader>
          <CardBody>
            <Text size="small">Inline test panel in RuleFormDialog. URL match + rewrite preview.</Text>
            <Tag tone="success">Done</Tag>
          </CardBody>
        </Card>
        <Card>
          <CardHeader><H3>Dark Mode</H3></CardHeader>
          <CardBody>
            <Text size="small">Light / Dark / System. CSS variables. All components updated.</Text>
            <Tag tone="success">Done</Tag>
          </CardBody>
        </Card>
        <Card>
          <CardHeader><H3>Icon Badge</H3></CardHeader>
          <CardBody>
            <Text size="small">Active rule count on extension icon with debounced updates.</Text>
            <Tag tone="success">Done</Tag>
          </CardBody>
        </Card>
        <Card>
          <CardHeader><H3>Rule Templates</H3></CardHeader>
          <CardBody>
            <Text size="small">4 quick-start templates for common proxy patterns.</Text>
            <Tag tone="success">Done</Tag>
          </CardBody>
        </Card>
        <Card>
          <CardHeader><H3>Log Enhancement</H3></CardHeader>
          <CardBody>
            <Text size="small">Filter by rule name + URL keyword search.</Text>
            <Tag tone="success">Done</Tag>
          </CardBody>
        </Card>
        <Card>
          <CardHeader><H3>Keyboard Shortcuts</H3></CardHeader>
          <CardBody>
            <Text size="small">Cmd+N / / / Esc. Documented in Settings.</Text>
            <Tag tone="success">Done</Tag>
          </CardBody>
        </Card>
      </Grid>

      <Divider />

      <H2>Code Review Catches</H2>
      <Table
        headers={['Severity', 'Issue', 'Fix']}
        rows={[
          ['Critical', 'GET_* responses wrapped breaking all consumers', 'Reverted to raw data format'],
          ['Critical', 'Dark mode icons missing after lint fix', 'Re-imported icon components'],
          ['Critical', 'Old imports lose rules silently', 'Removed priority/enabled from validation'],
          ['Warning', 'addRule silent failure when SW down', 'Fixed undefined response check'],
          ['Warning', 'Debounce timer leak on unmount', 'Added onUnmounted cleanup'],
          ['Suggestion', 'generateId counter resets on SW restart', 'Used crypto.randomUUID()'],
          ['Suggestion', 'Log buffer lost on SW suspend', 'Added onSuspend flushLogs'],
        ]}
        rowTone={['danger', 'danger', 'danger', 'warning', 'warning', 'info', 'info']}
      />

      <Divider />

      <H2>Final Verification</H2>
      <Grid columns={3} gap={16}>
        <Stat value="PASS" label="pnpm build" tone="success" />
        <Stat value="25/25" label="pnpm test" tone="success" />
        <Stat value="0 issues" label="pnpm lint" tone="success" />
      </Grid>

      <Text tone="secondary" size="small">
        3 Research + 12 Coding + 3 CodeReview + 2 Verify agents | 25+ files | 32 improvements
      </Text>
    </Stack>
  );
}
