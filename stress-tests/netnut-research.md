# NetNut Proxy Reseller Program Research

**Research Date:** February 15, 2026
**Company:** NetNut (netnut.io)
**Product Type:** Proxy-as-a-Service (Residential, Datacenter, ISP, Mobile)

---

## Executive Summary

NetNut is an **enterprise-grade proxy provider** with a dedicated reseller program, but pricing is **significantly higher** than PacketStream/Geonode alternatives. While they offer comprehensive white-label options and a robust API, their minimum entry point and per-GB costs make them less attractive for early-stage SaaS operations.

**Key Takeaway:** NetNut targets mid-to-large enterprises with $300-4,000/month budgets. For DomiNode's reseller strategy, **Geonode ($0.45-0.50/GB) or PacketStream ($1.00/GB) remain superior options** due to lower costs and clearer reseller API access.

---

## 1. Reseller API Availability

### ✅ **Available with Limitations**

- **Proxy Management API:** REST API at `gate.netnut.io` for proxy pool management
- **Sub-user Management:** Create and manage sub-accounts with isolated usage tracking
- **Usage Statistics:** Detailed bandwidth monitoring per sub-user
- **Authentication:** USERNAME:PASSWORD or IP whitelisting
- **Protocols:** HTTP, HTTPS, SOCKS5

### ⚠️ **Limitations**

- **No Public Reseller API Documentation:** Must contact sales for API access details
- **Enterprise-Only Feature:** API access requires Master plan ($4,000/month) or custom enterprise tier
- **No Self-Service Reseller Portal:** Unlike PacketStream's automated reseller API, NetNut requires manual sales process

**Sources:**
- [NetNut Resellers Program](https://netnut.io/resellers/)
- [NetNut Documentation Overview](https://help.netnut.io/netnut-documentation)
- [Proxyway In-Depth Review](https://proxyway.com/reviews/netnut-proxies)

---

## 2. Pricing Tiers

### Residential Proxies (Rotating)

| Plan | Bandwidth | Monthly Cost | Per-GB Cost | Annual Cost/Month | Per-GB (Annual) |
|------|-----------|--------------|-------------|-------------------|-----------------|
| **Starter** | 14 GB | $99 | $7.07 | $84 | $6.00 |
| **Basic** | 20 GB | $300 | $15.00 | — | — |
| **Professional** | 100 GB | $1,000 | $10.00 | — | — |
| **Advanced** | 500 GB | $3,500 | $7.00 | — | — |
| **Master** | 1 TB | $4,000 | $4.00 | — | — |

### Datacenter Proxies

- **Price:** $0.45/GB (150,000+ IPs, 99.99% uptime)
- **Minimum:** Not publicly disclosed (likely 5-20 GB)

### Static Residential Proxies

- **Smallest Package:** 5 GB for $115 (static) = $23/GB

### ISP Proxies

- **Price:** $1.59/GB (starting price, volume discounts available)

### Mobile Proxies (3G/4G/5G)

- **Pricing:** Custom enterprise quotes only (no public pricing)

### Enterprise Volume Discounts

- **10 TB+:** $3.75/GB ($37,500/month for 10TB)
- **Custom Tiers:** Negotiated pricing for 50TB+ commitments

**Sources:**
- [NetNut Pricing Comparison 2026](https://www.motocms.com/blog/en/top-premium-proxy-server-providers-in-2026/)
- [RapidSeedbox NetNut Review](https://www.rapidseedbox.com/blog/netnut-review-and-alternatives)
- [How Much Does a Proxy Cost? 2026](https://research.aimultiple.com/proxy-pricing/)

---

## 3. Minimum Requirements

### Deposit/Purchase Minimums

- **Smallest Package:** 5 GB for $100 (rotating) or $115 (static)
- **Reseller Entry:** Likely $300/month (Basic plan) minimum for API access
- **Enterprise API:** $4,000/month (Master plan) for full API + city/state targeting

### Commitment Terms

- **Monthly:** Pay-as-you-go, no long-term contract
- **Annual:** 15-20% discount over monthly pricing
- **Reseller Contracts:** Negotiated terms with sales team (likely 6-12 month minimum)

**Sources:**
- [NetNut Pricing Details](https://www.capterra.com/p/10015437/NetNut/)
- [NetNut FAQ](https://netnut.io/faq/)

---

## 4. Proxy Types Available

### ✅ Full Proxy Portfolio

| Type | IP Pool Size | Key Features |
|------|--------------|--------------|
| **Residential (Rotating)** | 85M+ IPs | 195 countries, ISP routing, auto-rotation |
| **Static Residential** | 1M+ IPs | Persistent IPs, residential authenticity |
| **Datacenter** | 150K+ IPs | High-speed, 99.99% uptime, cheap |
| **ISP Proxies** | Undisclosed | Datacenter speed + residential trust |
| **Mobile (3G/4G/5G)** | Undisclosed | Highest trust score, mobile carrier IPs |

**Sources:**
- [NetNut Proxy Types Overview](https://netnut.io/proxy-service/)
- [NetNut Residential Proxies](https://netnut.io/residential-proxies/)

---

## 5. API Documentation Quality

### 📄 **Moderate (Restricted Access)**

**Publicly Available:**
- Overview pages with integration guides
- Code examples for 7+ languages (.NET, Java, Node.js, PHP, Python, Ruby, Linux)
- Protocol documentation (HTTP/HTTPS/SOCKS5)

**Behind Sales Wall:**
- Reseller API endpoints and authentication
- Sub-user management API
- Webhook/callback integration
- Billing API for automated invoicing

**Documentation Portal:** [help.netnut.io/netnut-documentation](https://help.netnut.io/netnut-documentation)

**Rating:** ⭐⭐⭐☆☆ (3/5)
*Good integration guides, but reseller-specific API docs require sales contact*

**Sources:**
- [NetNut GitHub Repository](https://github.com/NetNut-Proxy-Network/NetNut)
- [NetNut Documentation](https://help.netnut.io/netnut-documentation)

---

## 6. Geographic Coverage

### 🌍 **Excellent Coverage**

- **Countries:** 195+ worldwide
- **Residential IPs:** 85M+ global pool
- **US Targeting:** City and state-level selection (Master plan only)
- **Global Targeting:** Country, state, city levels
- **ISP Selection:** Yes (US and select countries)
- **ASN Targeting:** Yes (enterprise plans)

**Sources:**
- [NetNut Residential Proxies](https://netnut.io/residential-proxies/)
- [NetNut Proxy Locations](https://netnut.io/proxy-locations/)

---

## 7. Authentication Methods

### 🔐 **Two Options**

1. **USERNAME:PASSWORD**
   - Format: `http://username:password@gate.netnut.io:8080`
   - Supports geo-targeting via username parameters
   - Example: `http://username-country-us:password@gate.netnut.io:8080`

2. **IP Whitelisting**
   - Format: `http://gate.netnut.io:8080` (no credentials needed)
   - Requires manual setup via NetNut dashboard
   - Limited to 10 IPs per account (configurable)

**Proxy Endpoint:** `gate.netnut.io:8080` (HTTP/HTTPS) + SOCKS5 support

**Sources:**
- [NetNut Protocols Documentation](https://help.netnut.io/netnut-documentation/netnut-proxies/residential-proxies/protocols)
- [Comparitech NetNut Guide](https://www.comparitech.com/proxies/netnut-proxy-service/)

---

## 8. White-Label Options

### ✅ **Full White-Label Support**

**Included Features:**
- Custom branding (reseller can use own domain/brand)
- Sub-user management (create isolated client accounts)
- Independent pricing control (set your own markup)
- Dedicated pools (optional for large resellers)
- White-label dashboard access

**Requirements:**
- Must contact sales team for setup
- Likely requires minimum commitment (e.g., $1,000-5,000/month)
- May require custom domain configuration

**Use Case for DomiNode:**
✅ **Good:** Could rebrand NetNut proxies as "Dominus Node Residential Network"
❌ **Expensive:** Need $300-4,000/month minimum to access reseller features

**Sources:**
- [NetNut Resellers Page](https://netnut.io/proxy-use-cases/resellers/)
- [NetNut Resellers Program](https://netnut.io/resellers/)

---

## 9. Bandwidth vs IP-Based Pricing

### 📊 **Bandwidth-Based (Primary)**

NetNut uses **bandwidth metering** as the default pricing model:

- **Billing Calculation:** Request headers + request data + response headers + response data
- **Bandwidth Pooling:** Shared across all sub-users (reseller manages allocation)
- **Overage Charges:** $15/GB above plan limit (residential) or $0.45/GB (datacenter)

### 🔢 **IP-Based (Static Proxies Only)**

- **Static Residential:** Price per IP (e.g., 100 IPs for $X/month)
- **Datacenter:** Can be purchased per IP or bandwidth
- **Not Available:** Mobile and rotating residential are bandwidth-only

**Sources:**
- [NetNut FAQ](https://netnut.io/faq/)
- [Proxyway NetNut Review](https://proxyway.com/reviews/netnut-proxies)

---

## 10. Free Trial & Low-Entry Options

### 🆓 **7-Day Free Trial (Qualified Businesses Only)**

**Eligibility:**
- ✅ Certified businesses (registered company)
- ❌ Individual developers (must purchase micro plan)

**How to Apply:**
1. Contact sales via WhatsApp, Telegram, Skype, email, or live chat
2. Explain use case: target domains, bandwidth needs, proxy type
3. Sales team approves or denies within 24-48 hours
4. Trial account provisioned with limited bandwidth (typically 5-10 GB)

**After Trial Ends:**
- Must purchase minimum 5 GB plan ($100 for rotating, $115 for static)
- Residential permissions disabled until payment

### 💰 **Low-Entry Option for Individuals**

- **Micro Plan:** 5 GB for $100 = $20/GB (no trial needed)

**Sources:**
- [NetNut Free Trial Information](https://netnut.io/residential-proxy-free-trial/)
- [TechRadar NetNut Review](https://www.techradar.com/reviews/netnut)
- [NetNut FAQ](https://netnut.io/faq/)

---

## Comparison: NetNut vs Geonode vs PacketStream

| Feature | **NetNut** | **Geonode** | **PacketStream** |
|---------|-----------|-------------|------------------|
| **Reseller API** | ✅ (sales contact) | ✅ (self-service) | ✅ (self-service) |
| **Minimum Cost** | $100 (5 GB) | $50 (10 GB) | $50 (50 GB) |
| **Per-GB Cost** | $1.59-15.00 | $0.45-0.50 | $1.00 |
| **White-Label** | ✅ Yes | ✅ Yes | ✅ Yes |
| **Free Trial** | 7 days (approved) | No | No |
| **API Docs** | ⭐⭐⭐☆☆ | ⭐⭐⭐⭐☆ | ⭐⭐⭐⭐⭐ |
| **Geo Coverage** | 195 countries | 145 countries | 100+ countries |
| **IP Pool** | 85M residential | 20M+ residential | 7M+ residential |
| **Best For** | Large enterprises | Cost-conscious resellers | MVP/startups |

**Sources:**
- [15 Best Residential Proxies 2025](https://proxyempire.io/best-residential-proxies-in-2025/)
- [PacketStream Pricing](https://packetstream.io/pricing/)

---

## Recommendation for DomiNode

### ❌ **Not Recommended for Phase 3 (Alpha/Beta)**

**Reasons:**

1. **Too Expensive:** $1.59/GB (ISP) or $7-15/GB (residential) vs Geonode $0.45/GB
2. **High Barrier to Entry:** $300/month minimum for Basic plan vs PacketStream $50
3. **Sales-Gated API:** No self-service reseller onboarding (delays launch)
4. **Overkill for MVP:** 85M IP pool is excessive when 1M IPs (Geonode) is sufficient

### ✅ **Consider for Phase 5 (Scale & Enterprise)**

**When NetNut Makes Sense:**

- DomiNode reaches 10TB+/month (NetNut drops to $3.75/GB at 10TB)
- Enterprise clients demand city/state-level targeting (NetNut's Master plan feature)
- Need 99.99% uptime SLA for high-value customers
- Require dedicated IP pools for compliance/security

---

## Action Items

1. ✅ **Stick with current plan:** PacketStream ($1.00/GB) for MVP launch
2. ✅ **Add Geonode:** Tier 2 sourcing at $0.45/GB for cost optimization
3. ⏸️ **Defer NetNut:** Revisit when monthly volume exceeds 5TB ($3,500+ budget)
4. 📝 **Track Pricing:** Monitor NetNut's enterprise discounts quarterly

---

## Sources

- [NetNut - High Quality Proxies Network](https://netnut.io/)
- [Resellers Program - NetNut](https://netnut.io/resellers/)
- [NetNut Documentation](https://help.netnut.io/netnut-documentation)
- [NetNut Residential Proxies](https://netnut.io/residential-proxies/)
- [NetNut Proxy Locations](https://netnut.io/proxy-locations/)
- [NetNut FAQ](https://netnut.io/faq/)
- [NetNut Reviews 2026 - SourceForge](https://sourceforge.net/software/product/NetNut/)
- [NetNut Review - RapidSeedbox](https://www.rapidseedbox.com/blog/netnut-review-and-alternatives)
- [NetNut Review - TechRadar](https://www.techradar.com/reviews/netnut)
- [NetNut Proxy Review - TechBloat](https://www.techbloat.com/netnut-proxy-review-types-pricing-cons-and-use-cases.html)
- [NetNut Free Trial Information](https://netnut.io/residential-proxy-free-trial/)
- [In-Depth NetNut Review - Proxyway](https://proxyway.com/reviews/netnut-proxies)
- [How Much Does a Proxy Cost? 2026](https://research.aimultiple.com/proxy-pricing/)
- [Top Premium Proxy Server Providers 2026](https://www.motocms.com/blog/en/top-premium-proxy-server-providers-in-2026/)
- [15 Best Residential Proxies 2025 - ProxyEmpire](https://proxyempire.io/best-residential-proxies-in-2025/)
- [NetNut GitHub Repository](https://github.com/NetNut-Proxy-Network/NetNut)
- [PacketStream Pricing](https://packetstream.io/pricing/)
- [NetNut Protocols Documentation](https://help.netnut.io/netnut-documentation/netnut-proxies/residential-proxies/protocols)
- [Comparitech NetNut Guide](https://www.comparitech.com/proxies/netnut-proxy-service/)
