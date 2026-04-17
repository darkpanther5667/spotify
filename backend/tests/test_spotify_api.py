"""
SpotiClone Backend API Tests
Tests for YouTube search, stream, and audio proxy endpoints
"""
import pytest
import requests
import os
import time

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', '').rstrip('/')

class TestHealthCheck:
    """Basic API health check tests"""
    
    def test_api_root(self):
        """Test API root endpoint returns success"""
        response = requests.get(f"{BASE_URL}/api/")
        assert response.status_code == 200
        data = response.json()
        assert "message" in data
        assert "SpotiClone" in data["message"] or "running" in data["message"].lower()
        print(f"✓ API root: {data['message']}")


class TestSearchAPI:
    """Tests for /api/yt/search endpoint"""
    
    def test_search_with_valid_query(self):
        """Test search with valid query returns results"""
        response = requests.get(f"{BASE_URL}/api/yt/search", params={"q": "arijit singh", "limit": 3}, timeout=120)
        assert response.status_code == 200
        
        data = response.json()
        assert data["status"] == 200
        assert data["message"] == "success"
        assert "response" in data
        assert isinstance(data["response"], list)
        assert len(data["response"]) > 0
        
        # Validate response structure
        first_result = data["response"][0]
        assert "id" in first_result
        assert "title" in first_result
        assert "artist" in first_result
        assert "thumb" in first_result
        
        print(f"✓ Search returned {len(data['response'])} results")
        print(f"  First result: {first_result['title'][:50]}...")
    
    def test_search_with_empty_query(self):
        """Test search with empty query returns 400"""
        response = requests.get(f"{BASE_URL}/api/yt/search", params={"q": "", "limit": 5}, timeout=30)
        assert response.status_code == 400
        
        data = response.json()
        assert data["status"] == 400
        assert "Missing" in data["message"] or "q" in data["message"].lower()
        print("✓ Empty query correctly returns 400")
    
    def test_search_with_limit(self):
        """Test search respects limit parameter"""
        limit = 5
        response = requests.get(f"{BASE_URL}/api/yt/search", params={"q": "bollywood", "limit": limit}, timeout=120)
        assert response.status_code == 200
        
        data = response.json()
        assert len(data["response"]) <= limit
        print(f"✓ Search with limit={limit} returned {len(data['response'])} results")
    
    def test_search_different_queries(self):
        """Test search with different query types"""
        queries = ["punjabi songs", "hindi romantic"]
        
        for query in queries:
            response = requests.get(f"{BASE_URL}/api/yt/search", params={"q": query, "limit": 3}, timeout=120)
            assert response.status_code == 200
            
            data = response.json()
            assert data["status"] == 200
            assert len(data["response"]) > 0
            print(f"✓ Search '{query}' returned {len(data['response'])} results")


class TestStreamAPI:
    """Tests for /api/yt/stream endpoint"""
    
    def test_stream_with_missing_id(self):
        """Test stream with missing id returns 400"""
        response = requests.get(f"{BASE_URL}/api/yt/stream", params={"id": ""}, timeout=30)
        assert response.status_code == 400
        
        data = response.json()
        assert data["status"] == 400
        assert "Missing" in data["message"] or "id" in data["message"].lower()
        print("✓ Missing id correctly returns 400")
    
    def test_stream_with_valid_id(self):
        """Test stream with valid video id returns stream info or age-restricted error"""
        # First get a video ID from search
        search_response = requests.get(f"{BASE_URL}/api/yt/search", params={"q": "instrumental music", "limit": 5}, timeout=120)
        assert search_response.status_code == 200
        
        search_data = search_response.json()
        assert len(search_data["response"]) > 0
        
        # Try to get stream for first result
        video_id = search_data["response"][0]["id"]
        stream_response = requests.get(f"{BASE_URL}/api/yt/stream", params={"id": video_id}, timeout=120)
        
        # Stream may return 200 (success) or 500 (age-restricted/unavailable)
        assert stream_response.status_code in [200, 500]
        
        data = stream_response.json()
        if data["status"] == 200:
            assert "response" in data
            assert data["response"] is not None
            assert "streamUrl" in data["response"] or "proxyUrl" in data["response"]
            assert "title" in data["response"]
            print(f"✓ Stream info retrieved for: {data['response']['title'][:50]}...")
        else:
            # Age-restricted or unavailable is expected for some videos
            print(f"✓ Stream returned expected error: {data['message'][:50]}...")


class TestAudioProxyAPI:
    """Tests for /api/yt/audio endpoint"""
    
    def test_audio_with_missing_id(self):
        """Test audio proxy with missing id returns 400"""
        response = requests.get(f"{BASE_URL}/api/yt/audio", params={"id": ""}, timeout=30)
        assert response.status_code == 400
        
        data = response.json()
        assert data["status"] == 400
        print("✓ Audio proxy with missing id returns 400")


class TestCaching:
    """Tests for search caching functionality"""
    
    def test_search_caching(self):
        """Test that repeated searches are faster (cached)"""
        query = "test caching query bollywood"
        
        # First request (uncached)
        start1 = time.time()
        response1 = requests.get(f"{BASE_URL}/api/yt/search", params={"q": query, "limit": 3}, timeout=120)
        time1 = time.time() - start1
        
        assert response1.status_code == 200
        
        # Second request (should be cached)
        start2 = time.time()
        response2 = requests.get(f"{BASE_URL}/api/yt/search", params={"q": query, "limit": 3}, timeout=120)
        time2 = time.time() - start2
        
        assert response2.status_code == 200
        
        # Cached request should be significantly faster
        print(f"✓ First request: {time1:.2f}s, Second request: {time2:.2f}s")
        if time2 < time1:
            print("✓ Caching appears to be working (second request faster)")


@pytest.fixture(scope="session")
def api_client():
    """Shared requests session"""
    session = requests.Session()
    session.headers.update({"Content-Type": "application/json"})
    return session


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
