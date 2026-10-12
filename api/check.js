export const config = { maxDuration: 60 };

const SYSTEM_PROMPT = `당신은 알라딘 SEO 담당팀을 위한 자동 검수 시스템입니다.
주어진 HTML 소스를 분석하여 SEO 항목을 평가합니다.
반드시 순수 JSON만 출력하세요. 마크다운 코드블록이나 설명 텍스트를 절대 포함하지 마세요.`;

const USER_PROMPT = (url, seoHtml) => `다음 URL의 HTML을 분석하세요.

URL: ${url}

${seoHtml}

위 HTML을 분석해서 아래 각 key를 평가하고 JSON으로만 응답하세요.
---
status 값: pass(문제없음) / fail(명확한 문제) / warn(개선권장) / skip(이 도구로 확인불가)
detail: 실제 값이나 구체적인 이유를 간결하게 (50자 이내). detail 안에는 큰따옴표(")와 줄바꿈, 역슬래시를 절대 쓰지 말고 필요하면 작은따옴표를 쓰세요

평가 key와 기준:
- title_exists: title 태그가 있으면 pass, 없으면 fail. detail에 실제 title 텍스트 포함
- title_unique: 제목이 "알라딘"만 있거나 의미없이 짧으면 warn/fail
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
- noindex: noindex가 있으면 warn, 없으면 pass
- robots_meta: robots meta가 noindex/nofollow면 warn, 정상이면 pass
- js_hidden_content: 주요 콘텐츠가 JS 변수에만 있고 HTML 텍스트에 없으면 fail. bookData, CURATOR_DATA 같은 패턴 확인
- visibility_hidden: CSS에서 body에 visibility:hidden이 초기값이면 warn
- anchor_text: "서점 방문하기","더보기","바로가기" 같은 무의미한 앵커가 반복되면 warn/fail
- img_alt: 주요 이미지에 alt 속성이 있으면 pass, 없으면 fail
- semantic_tags: main, header, nav, article 등 시맨틱 태그를 사용하면 pass
- schema_exists: script type="application/ld+json"이 있으면 pass, 없으면 fail
- schema_type: Book, Product, BreadcrumbList 등 적절한 @type이면 pass
- breadcrumb: BreadcrumbList 스키마가 있으면 pass, 없으면 warn
- url_slug: ?id=숫자 같은 파라미터 방식이면 warn. detail에 URL 패턴 명시
- https: HTTPS면 pass, HTTP면 fail
- cwv_note: 항상 skip. detail = "pagespeed.web.dev 에서 확인하세요"
- lazy_load: 이미지에 loading="lazy" 속성이 있으면 pass
- img_dimensions: 이미지에 width/height 속성이 있으면 pass, 없으면 warn

응답은 반드시 아래 형식의 JSON만 출력:
{"title_exists":{"status":"pass","detail":"실제 타이틀 텍스트"},...}`;

function extractSEORelevant(html) {
  const head = html.match(/<head[\s\S]*?<\/head>/i)?.[0] || '';
  const body = html.match(/<body[\s\S]*?<\/body>/i)?.[0] || '';
  return `HEAD:\n${head}\n\nBODY(앞부분):\n${body.slice(0, 30000)}`;  
}

// 모델이 detail 안에 이스케이프 안 된 따옴표를 넣었을 때를 대비한 복구 파서
function parseResult(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    const result = {};
    const re = /"(\w+)"\s*:\s*\{\s*"status"\s*:\s*"(pass|fail|warn|skip)"\s*,\s*"detail"\s*:\s*"([\s\S]*?)"\s*\}(?=\s*[,}])/g;
    let m;
    while ((m = re.exec(raw))) {
      result[m[1]] = { status: m[2], detail: m[3].replace(/\s+/g, ' ').trim() };
    }
    if (!Object.keys(result).length) throw new Error('응답 JSON 파싱 실패');
    return result;
  }
}

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
    const pageRes = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AladinSEOChecker/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ko-KR,ko;q=0.9',
      },
      redirect: 'follow',
    });

    if (!pageRes.ok) {
      return res.status(400).json({ error: `페이지를 가져올 수 없습니다. (${pageRes.status})` });
    }

    const html = await pageRes.text();
    const seoHtml = extractSEORelevant(html);

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5-5',
        max_tokens: 4000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: USER_PROMPT(url, seoHtml) }],
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

    const result = parseResult(match[0]);
    return res.status(200).json({ result });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
