const API_URLS = [
    'https://saavn.dev/api/search/songs',
    'https://jiosaavn-api-three-theta.vercel.app/api/search/songs',
    'https://jiosaavn-api-liart-three.vercel.app/api/search/songs',
    'https://jiosaavn-api-beta.vercel.app/api/search/songs'
];

async function checkApis() {
    for (const url of API_URLS) {
        try {
            console.log(`Checking ${url}...`);
            const res = await fetch(`${url}?query=Arijit+Singh&limit=1`);
            if (res.ok) {
                const data = await res.json();
                if (data.status === 'SUCCESS' || data.success) {
                    console.log(`Found working API: ${url}`);
                    return url;
                }
            }
        } catch (e) {
            console.error(`Failed ${url}:`, e);
        }
    }
    return null;
}

checkApis().then(url => {
    if (url) {
        console.log(`Final URL: ${url}`);
    } else {
        console.log("No working API found.");
    }
});
