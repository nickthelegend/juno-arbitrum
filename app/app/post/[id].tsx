import { useLocalSearchParams, useRouter } from "expo-router";
import { Handle } from "../../components/Handle";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, RefreshControl, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import styled from "styled-components/native";

import { Identicon } from "../../components/art";
import { Body, Button, Caption, Card, ChevronLeft, Col, Delta, Heading, Label, Mono, Placeholder, Progress, Row, Skeleton } from "../../components/kit";
import { juno, type PostDetail } from "../../lib/api";
import { money, since, useApi } from "../../lib/useApi";
import { useWallet } from "../../lib/wallet";
import { theme } from "../../theme";

/**
 * A post and its conversation.
 *
 * A reply is a post with a parent — same author, body and cluster scoping — so
 * this screen and the feed render the same shape and there is no second schema
 * to keep in step.
 *
 * When the post is about a coin, the coin is shown live rather than as a name.
 * The whole premise is that a post *is* a market, and an argument for one is
 * worth very little next to a stale price.
 */
export default function PostScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const wallet = useWallet();

  const detail = useApi(() => juno.post(id), [id]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reply() {
    const body = draft.trim();
    if (!body) return;
    setSending(true);
    setError(null);
    try {
      const author = wallet.address ?? (await wallet.connect());
      await juno.createPost({ authorWallet: author, body, parentId: id });
      setDraft("");
      detail.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not post that");
    } finally {
      setSending(false);
    }
  }

  const post = detail.data?.post;
  const coin = detail.data?.coin;

  return (
    <Page edges={["top"]}>
      <Nav>
        <Back onPress={() => router.back()} hitSlop={12} accessibilityRole="button">
          <ChevronLeft />
        </Back>
        <Heading>Post</Heading>
      </Nav>

      {detail.loading ? (
        <Padded>
          <Skeleton h={120} round={22} />
        </Padded>
      ) : detail.errorStatus === 404 ? (
        <Placeholder
          title="No such post"
          detail="It may have been removed, or the link is wrong."
          action={<Button label="Back to the feed" onPress={() => router.replace("/(tabs)/social" as never)} />}
        />
      ) : detail.error || !post ? (
        <Placeholder
          title="Could not load this post"
          detail={detail.error ?? undefined}
          action={<Button label="Try again" onPress={detail.refresh} />}
        />
      ) : (
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={{ flex: 1 }}
          keyboardVerticalOffset={90}
        >
          <ScrollView
            contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24, gap: 12 }}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            refreshControl={
              <RefreshControl
                refreshing={detail.refreshing}
                onRefresh={detail.refresh}
                tintColor={theme.colors.muted}
              />
            }
          >
            <Card>
              <Row gap={10}>
                <Identicon seed={post.author.wallet} size={36} />
                <Col gap={1} style={{ flex: 1 }}>
                  <Label style={{ fontWeight: "700" }}><Handle wallet={post.author.wallet} /></Label>
                  <Caption>{since(post.timestamp)} ago</Caption>
                </Col>
              </Row>
              <PostBody>{post.body}</PostBody>
            </Card>

            {/* The market the post is about, priced now. */}
            {coin ? (
              <CoinTap onPress={() => router.push(`/coin/${coin.address}`)}>
                <Card>
                  <Row gap={12}>
                    <Identicon seed={coin.address} size={40} />
                    <Col gap={2} style={{ flex: 1 }}>
                      <Label style={{ fontWeight: "700" }} numberOfLines={1}>
                        {coin.name}
                      </Label>
                      <Caption>${coin.symbol}</Caption>
                    </Col>
                    <Col gap={3} style={{ alignItems: "flex-end" }}>
                      <Mono>{money(coin.marketCap, coin.currency)}</Mono>
                      <Delta pct={coin.changePct} />
                    </Col>
                  </Row>
                  {!coin.graduated ? (
                    <ProgressWrap>
                      <Progress pct={coin.progress * 100} />
                      <Caption style={{ marginTop: 6 }}>
                        {(coin.progress * 100).toFixed(2)}% to graduation
                      </Caption>
                    </ProgressWrap>
                  ) : null}
                </Card>
              </CoinTap>
            ) : null}

            <Row justify="space-between" style={{ paddingHorizontal: 4, marginTop: 4 }}>
              <Heading style={{ fontSize: theme.type.lead.size }}>
                {detail.data!.replyCount === 0
                  ? "No replies yet"
                  : `${detail.data!.replyCount} ${detail.data!.replyCount === 1 ? "reply" : "replies"}`}
              </Heading>
            </Row>

            {detail.data!.replies.map((reply) => (
              <Reply key={reply.id} reply={reply} />
            ))}

            {error ? <ErrorText>{error}</ErrorText> : null}
          </ScrollView>

          {/* The composer sits above the keyboard rather than scrolling away —
              a reply box you have to hunt for is a reply nobody writes. */}
          <Composer>
            <Identicon seed={wallet.address ?? "guest"} size={30} />
            <Input
              value={draft}
              onChangeText={setDraft}
              placeholder="Write a reply…"
              placeholderTextColor={theme.colors.faint}
              multiline
              maxLength={500}
            />
            <Button
              label={sending ? "…" : "Reply"}
              onPress={reply}
              loading={sending}
              disabled={draft.trim().length === 0}
            />
          </Composer>
        </KeyboardAvoidingView>
      )}
    </Page>
  );
}

function Reply({ reply }: { reply: PostDetail }) {
  return (
    <Card>
      <Row gap={10}>
        <Identicon seed={reply.author.wallet} size={26} />
        <Label style={{ fontWeight: "700" }}><Handle wallet={reply.author.wallet} /></Label>
        <Grow />
        <Caption>{since(reply.timestamp)}</Caption>
      </Row>
      <Body style={{ marginTop: 8 }}>{reply.body}</Body>
    </Card>
  );
}

const Page = styled(SafeAreaView)`
  flex: 1;
  background-color: ${(p) => p.theme.colors.bg};
`;

const Nav = styled.View`
  flex-direction: row;
  align-items: center;
  gap: ${(p) => p.theme.space(3)}px;
  padding-horizontal: ${(p) => p.theme.space(4)}px;
  padding-bottom: ${(p) => p.theme.space(3)}px;
`;

const Back = styled.Pressable`
  width: 36px;
  height: 36px;
  border-radius: 18px;
  background-color: ${(p) => p.theme.colors.surface};
  align-items: center;
  justify-content: center;
`;


const Padded = styled.View`
  padding: ${(p) => p.theme.space(4)}px;
`;

const PostBody = styled.Text`
  font-size: ${(p) => p.theme.type.lead.size}px;
  line-height: 25px;
  color: ${(p) => p.theme.colors.text};
  margin-top: ${(p) => p.theme.space(3)}px;
`;

const CoinTap = styled.Pressable``;

const ProgressWrap = styled.View`
  margin-top: ${(p) => p.theme.space(3)}px;
`;

const Grow = styled.View`
  flex: 1;
`;

const Composer = styled.View`
  flex-direction: row;
  align-items: flex-end;
  gap: ${(p) => p.theme.space(2)}px;
  padding: ${(p) => p.theme.space(3)}px;
  padding-bottom: ${(p) => p.theme.space(5)}px;
  background-color: ${(p) => p.theme.colors.surface};
  border-top-width: 1px;
  border-top-color: ${(p) => p.theme.colors.line};
`;

const Input = styled.TextInput`
  flex: 1;
  max-height: 110px;
  min-height: 44px;
  border-radius: ${(p) => p.theme.radius.lg}px;
  background-color: ${(p) => p.theme.colors.surfaceAlt};
  padding-horizontal: ${(p) => p.theme.space(4)}px;
  padding-top: ${(p) => p.theme.space(3)}px;
  padding-bottom: ${(p) => p.theme.space(3)}px;
  font-size: ${(p) => p.theme.type.body.size}px;
  color: ${(p) => p.theme.colors.text};
`;

const ErrorText = styled.Text`
  font-size: ${(p) => p.theme.type.label.size}px;
  color: ${(p) => p.theme.colors.neg};
  text-align: center;
`;
