export const config = { maxDuration: 60 };

const SYSTEM_PROMPT = `당신은 알라딘 SEO 담당팀을 위한 자동 검수 시스템입니다.
주어진 URL의 HTML 소스를 분석하여 SEO 항목을 평가합니다.
반드시 순수 JSON만 출력하세요. 마크다운 코드블록이나 설명 텍스트를 절대 포함하지 마세요.`;

const USER_PROMPT = (url) => `다음 URL을 분석하세요: ${url}

web_search 도구로 해당 페이지의 HTML 소스를 가져와서 아래 각 key를 평가하고 JSON으로만 응답하세요.

status 값: pass(문제없음) / fail(명확한 문제) / warn(개선권장) / skip(이 도구로 확인불가)
detail: 실제 값이나 구체적인 이유를 간결하게 (50자 이내)

평가 key와 기준:
- title_exists: title 태그가 있으면 pass, 없으면 fail. detail에 실제 title 텍스트 포함
- title_unique: 제목이 "알라딘"만 있거나 모든 페이지가 동일할 것 같으면 warn/fail
- title_length: 30~60자면 pass, 벗어나면 warn. detail에 글자수 포함
- desc_exists: meta description이 있으면 pass, 없으면 fail
- desc_length: 80~160자면 pass. detail에 글자수 포함
- h1_count: H1이 정확히 1개면 pass, 없으면 fail, 2개 이상이면 warn. detail에 개수 포함
- heading_structure: H1→H2→H3 계층이 논리적이면 pass, 건너뛰면 warn
- lang: html 태그에 lang="ko"가 있으면 pass
- charset: meta charset utf-8이면 pass
- viewport: meta viewport가 있으면 pass
- og_tags: og:title, og:description 등이 있으면 pass, 없으면 fail
- canonical: canonical 링크가 있으면 pass, 없으면 warn
- noindex: noindex가 있으면 warn(의도적인지 확인 필요), 없으면 pass
- robots_meta: robots meta가 noindex/nofollow면 warn, 정상이면 pass
- js_hidden_content: 주요 콘텐츠(도서목록, 추천글 등)가 JS 변수에만 있고 HTML 텍스트에 없으면 fail. bookData, CURATOR_DATA 같은 변수 패턴 확인
- visibility_hidden: CSS에서 body 또는 주요 컨테이너에 visibility:hidden이 초기값이면 warn
- anchor_text: "서점 방문하기", "더보기", "바로가기" 같은 무의미한 앵커가 반복되면 warn/fail. detail에 반복 텍스트 예시 포함
- img_alt: 주요 이미지(책표지 등)에 alt 속성이 있으면 pass, 없으면 fail
- semantic_tags: main, header, nav, article, section 등 시맨틱 태그를 사용하면 pass
- schema_exists: script type="application/ld+json"이 있으면 pass, 없으면 fail
- schema_type: Book, Product, BreadcrumbList 등 적절한 @type이면 pass
- breadcrumb: BreadcrumbList 스키마가 있으면 pass, 없으면 warn
- url_slug: ?id=숫자 같은 파라미터 방식이면 warn. detail에 현재 URL 패턴 명시
- https: HTTPS면 pass, HTTP면 fail
- cwv_note: 항상 skip. detail = "pagespeed.web.dev 에서 확인하세요"
- lazy_load: 이미지에 loading="lazy" 속성이 있으면 pass
- img_dimensions: 이미지에 width/height 속성이 있으면 pass, 없으면 warn

응답은 반드시 아래 형식의 JSON만 출력 (다른 텍스트 없이):
{"title_exists":{"status":"pass","detail":"실제 타이틀 텍스트"},"title_unique":{"status":"warn","detail":"이유"},...}`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { url } = req.body;
  if (!url || !url.startsWith('http')) {
    return res.status(400).json({ error: '올바른 URL을 입력해주세요.' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key가 설정되지 않았습니다.' });

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: USER_PROMPT(url) }],
      }),
    });

    if (!anthropicRes.ok) {
      const err = await anthropicRes.json();
      return res.status(500).json({ error: err.error?.message || 'Anthropic API 오류' });
    }

    const data = await anthropicRes.json();
    const text = data.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return res.status(500).json({ error: '응답 파싱 실패' });

    const result = JSON.parse(match[0]);
    return res.status(200).json({ result });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

